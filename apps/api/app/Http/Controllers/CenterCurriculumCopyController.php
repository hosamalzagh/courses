<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterCurriculumCopyController extends Controller
{
    public function preview(Request $request, string $courseId): JsonResponse
    {
        abort_unless(Str::isUuid($courseId), 404);
        $data = $request->validate([
            'target_branch_id' => ['required', 'integer', 'min:1'],
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        [$source, $target] = $this->sourceAndTarget($courseId, (int) $data['target_branch_id'], $permissions);
        abort_if((int) $source->branch_id === $target->id, 422, 'اختر فرعًا آخر لنسخ المنهج.');
        $snapshot = $this->snapshot($source);

        return response()->json($this->previewPayload($source, $target, $snapshot, (int) ($data['page'] ?? 1)))
            ->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request, string $courseId): JsonResponse
    {
        abort_unless(Str::isUuid($courseId), 404);
        $data = $request->validate([
            'target_branch_id' => ['required', 'integer', 'min:1'],
            'snapshot_hash' => ['required', 'regex:/^[a-f0-9]{64}$/'],
            'request_id' => ['required', 'uuid'],
        ]);

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $courseId, $data): JsonResponse {
            [$source, $target] = $this->sourceAndTarget($courseId, (int) $data['target_branch_id'], $permissions);
            abort_if((int) $source->branch_id === $target->id, 422, 'اختر فرعًا آخر لنسخ المنهج.');
            $requestHash = hash('sha256', json_encode([$courseId, $target->id, $data['snapshot_hash']]));
            $previous = DB::connection('tenant')->table('curriculum_course_copies')
                ->where('request_id', $data['request_id'])->first();
            if ($previous !== null) {
                abort_unless((int) $previous->created_by === $request->user()->id, 403);
                if ($previous->request_hash !== $requestHash) {
                    $this->conflict('curriculum_copy_request_changed');
                }

                return response()->json(['course_id' => $previous->copied_course_id, 'replayed' => true]);
            }

            $snapshot = $this->snapshot($source);
            $snapshotHash = $this->hashSnapshot($snapshot);
            if ($snapshotHash !== $data['snapshot_hash']) {
                $this->conflict('curriculum_source_changed');
            }
            $now = now();
            $newCourseId = (string) Str::uuid();
            DB::connection('tenant')->table('courses')->insert([
                'id' => $newCourseId, 'branch_id' => $target->id, 'name' => $snapshot['course']['name'],
                'completion_threshold' => $snapshot['course']['completion_threshold'], 'completion_revision' => 1,
                'absence_mode' => $snapshot['course']['absence_mode'], 'absence_limit' => $snapshot['course']['absence_limit'],
                'absence_revision' => 1, 'created_at' => $now, 'updated_at' => $now,
            ]);
            $counts = ['stages' => 0, 'levels' => 0, 'plans' => 0, 'lectures' => 0];
            foreach ($snapshot['stages'] as $stage) {
                $newStageId = (string) Str::uuid();
                DB::connection('tenant')->table('stages')->insert([
                    'id' => $newStageId, 'course_id' => $newCourseId, 'name' => $stage['name'],
                    'completion_threshold' => $stage['completion_threshold'], 'completion_revision' => 1,
                    'absence_mode' => $stage['absence_mode'], 'absence_limit' => $stage['absence_limit'],
                    'absence_revision' => 1, 'created_at' => $now, 'updated_at' => $now,
                ]);
                $counts['stages']++;
                foreach ($stage['levels'] as $level) {
                    $newLevelId = (string) Str::uuid();
                    DB::connection('tenant')->table('levels')->insert([
                        'id' => $newLevelId, 'stage_id' => $newStageId, 'name' => $level['name'],
                        'completion_threshold' => $level['completion_threshold'], 'completion_revision' => 1,
                        'absence_mode' => $level['absence_mode'], 'absence_limit' => $level['absence_limit'],
                        'absence_revision' => 1, 'created_at' => $now, 'updated_at' => $now,
                    ]);
                    $counts['levels']++;
                    foreach ($level['plans'] as $plan) {
                        $newPlanId = (string) Str::uuid();
                        DB::connection('tenant')->table('study_plan_versions')->insert([
                            'id' => $newPlanId, 'level_id' => $newLevelId, 'version' => $plan['version'],
                            'revision' => 1, 'used_at' => null, 'created_at' => $now, 'updated_at' => $now,
                        ]);
                        $counts['plans']++;
                        if ($plan['lectures'] !== []) {
                            DB::connection('tenant')->table('plan_lectures')->insert(array_map(
                                fn (array $lecture): array => [
                                    'id' => (string) Str::uuid(), 'plan_version_id' => $newPlanId,
                                    'number' => $lecture['number'], 'content' => $lecture['content'],
                                    'title' => $lecture['title'], 'planned_hours' => $lecture['planned_hours'],
                                ], $plan['lectures']));
                            $counts['lectures'] += count($plan['lectures']);
                        }
                        if ($plan['version'] > 1) {
                            DB::connection('tenant')->table('study_plan_versions')->where('id', $newPlanId)
                                ->update(['sealed_at' => $now]);
                        }
                    }
                }
            }
            DB::connection('tenant')->table('curriculum_course_copies')->insert([
                'request_id' => $data['request_id'], 'source_course_id' => $courseId,
                'copied_course_id' => $newCourseId, 'source_branch_id' => $source->branch_id,
                'target_branch_id' => $target->id, 'source_course_name' => $source->name,
                'source_branch_name' => $source->branch_name, 'request_hash' => $requestHash,
                'snapshot_hash' => $snapshotHash, 'created_by' => $request->user()->id, 'created_at' => $now,
            ]);
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'branch_id' => $target->id,
                'event' => 'curriculum.course_copied',
                'details' => json_encode([
                    'source_course_id' => $courseId, 'source_course_name' => $source->name,
                    'source_branch_id' => $source->branch_id, 'source_branch_name' => $source->branch_name,
                    'copied_course_id' => $newCourseId, 'copied_course_name' => $source->name,
                    'counts' => $counts,
                ]), 'created_at' => $now,
            ]);

            return response()->json(['course_id' => $newCourseId, 'replayed' => false, 'counts' => $counts], 201);
        })->header('Cache-Control', 'private, no-store');
    }

    private function sourceAndTarget(string $courseId, int $targetBranchId, CenterPermissions $permissions): array
    {
        abort_unless($permissions->can('curriculum.manage', $targetBranchId), 404);
        $source = DB::connection('tenant')->table('courses')
            ->join('branches', 'branches.id', '=', 'courses.branch_id')
            ->join('branches as target_branch', fn ($join) => $join->where('target_branch.id', '=', $targetBranchId))
            ->where('courses.id', $courseId)->first([
                'courses.id', 'courses.branch_id', 'courses.name', 'courses.completion_threshold',
                'courses.completion_revision', 'courses.absence_mode', 'courses.absence_limit',
                'courses.absence_revision', 'branches.name as branch_name', 'target_branch.name as target_branch_name',
            ]);
        abort_unless($source && $permissions->can('read', (int) $source->branch_id), 404);

        return [$source, (object) ['id' => $targetBranchId, 'name' => $source->target_branch_name]];
    }

    private function snapshot(object $source): array
    {
        $rows = DB::connection('tenant')->table('stages')
            ->leftJoin('levels', 'levels.stage_id', '=', 'stages.id')
            ->leftJoin('study_plan_versions as plans', 'plans.level_id', '=', 'levels.id')
            ->leftJoin('plan_lectures as lectures', 'lectures.plan_version_id', '=', 'plans.id')
            ->where('stages.course_id', $source->id)
            ->orderBy('stages.created_at')->orderBy('stages.id')
            ->orderBy('levels.created_at')->orderBy('levels.id')
            ->orderBy('plans.version')->orderBy('lectures.number')
            ->get([
                'stages.id as stage_id', 'stages.name as stage_name',
                'stages.completion_threshold as stage_completion_threshold',
                'stages.completion_revision as stage_completion_revision',
                'stages.absence_mode as stage_absence_mode', 'stages.absence_limit as stage_absence_limit',
                'stages.absence_revision as stage_absence_revision',
                'levels.id as level_id', 'levels.name as level_name',
                'levels.completion_threshold as level_completion_threshold',
                'levels.completion_revision as level_completion_revision',
                'levels.absence_mode as level_absence_mode', 'levels.absence_limit as level_absence_limit',
                'levels.absence_revision as level_absence_revision',
                'plans.id as plan_id', 'plans.version as plan_version', 'plans.revision as plan_revision',
                'lectures.id as lecture_id', 'lectures.number as lecture_number',
                'lectures.content as lecture_content', 'lectures.title as lecture_title',
                'lectures.planned_hours as lecture_planned_hours',
            ]);
        $stages = [];
        foreach ($rows as $row) {
            $stageId = $row->stage_id;
            $stages[$stageId] ??= [
                'id' => $stageId, 'name' => $row->stage_name,
                'completion_threshold' => $row->stage_completion_threshold,
                'completion_revision' => $row->stage_completion_revision,
                'absence_mode' => $row->stage_absence_mode, 'absence_limit' => $row->stage_absence_limit,
                'absence_revision' => $row->stage_absence_revision, 'levels' => [],
            ];
            if ($row->level_id === null) {
                continue;
            }
            $levelId = $row->level_id;
            $stages[$stageId]['levels'][$levelId] ??= [
                'id' => $levelId, 'name' => $row->level_name,
                'completion_threshold' => $row->level_completion_threshold,
                'completion_revision' => $row->level_completion_revision,
                'absence_mode' => $row->level_absence_mode, 'absence_limit' => $row->level_absence_limit,
                'absence_revision' => $row->level_absence_revision, 'plans' => [],
            ];
            if ($row->plan_id === null) {
                continue;
            }
            $planId = $row->plan_id;
            $stages[$stageId]['levels'][$levelId]['plans'][$planId] ??= [
                'id' => $planId, 'version' => $row->plan_version,
                'revision' => $row->plan_revision, 'lectures' => [],
            ];
            if ($row->lecture_id !== null) {
                $stages[$stageId]['levels'][$levelId]['plans'][$planId]['lectures'][] = [
                    'id' => $row->lecture_id, 'number' => $row->lecture_number,
                    'content' => $row->lecture_content, 'title' => $row->lecture_title,
                    'planned_hours' => $row->lecture_planned_hours,
                ];
            }
        }
        foreach ($stages as &$stage) {
            foreach ($stage['levels'] as &$level) {
                $level['plans'] = array_values($level['plans']);
            }
            unset($level);
            $stage['levels'] = array_values($stage['levels']);
        }
        unset($stage);

        return ['course' => [
            'id' => $source->id, 'name' => $source->name,
            'completion_threshold' => $source->completion_threshold,
            'completion_revision' => $source->completion_revision,
            'absence_mode' => $source->absence_mode, 'absence_limit' => $source->absence_limit,
            'absence_revision' => $source->absence_revision,
        ], 'stages' => array_values($stages)];
    }

    private function previewPayload(object $source, object $target, array $snapshot, int $page): array
    {
        $outline = [];
        $counts = ['stages' => 0, 'levels' => 0, 'plans' => 0, 'lectures' => 0];
        foreach ($snapshot['stages'] as $stage) {
            $counts['stages']++;
            $outline[] = ['kind' => 'stage', 'name' => $stage['name']];
            foreach ($stage['levels'] as $level) {
                $counts['levels']++;
                $planCount = count($level['plans']);
                $lectureCount = array_sum(array_map(fn (array $plan): int => count($plan['lectures']), $level['plans']));
                $counts['plans'] += $planCount;
                $counts['lectures'] += $lectureCount;
                $outline[] = ['kind' => 'level', 'name' => $level['name'], 'stage_name' => $stage['name'],
                    'plans' => $planCount, 'lectures' => $lectureCount];
            }
        }
        $offset = ($page - 1) * 50;

        return [
            'source' => ['id' => $source->id, 'name' => $source->name,
                'branch_id' => $source->branch_id, 'branch_name' => $source->branch_name],
            'target' => ['id' => $target->id, 'name' => $target->name],
            'snapshot_hash' => $this->hashSnapshot($snapshot), 'counts' => $counts,
            'outline' => array_slice($outline, $offset, 50),
            'pagination' => ['page' => $page, 'has_more' => count($outline) > $offset + 50],
        ];
    }

    private function hashSnapshot(array $snapshot): string
    {
        return hash('sha256', json_encode($snapshot, JSON_THROW_ON_ERROR));
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
