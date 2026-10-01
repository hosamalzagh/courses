<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\StudyCoverageCredits;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterAttemptThresholdController extends Controller
{
    public function preview(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $change = $this->change($request);
        $permissions = $request->attributes->get('center_permissions');
        $group = $this->group($groupId, $permissions);
        abort_unless($permissions->canInWorkspace('curriculum.manage', $group->branch_id), 403);

        return response()->json($this->impact($group, $change))
            ->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $change = $this->change($request);
        $confirmation = $request->validate([
            'preview_token' => ['required', 'string', 'size:64'],
            'request_id' => ['required', 'uuid'],
        ]);
        $hash = hash('sha256', json_encode([$groupId, $change, $confirmation['preview_token']]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $groupId, $change, $confirmation, $hash): JsonResponse {
            $group = $this->group($groupId, $permissions, true);
            abort_unless($permissions->canInWorkspace('curriculum.manage', $group->branch_id), 403);
            $db = DB::connection('tenant');
            $previous = $db->table('study_threshold_submissions')
                ->where('request_id', $confirmation['request_id'])->first();
            if ($previous) {
                abort_unless($previous->group_id === $groupId && (int) $previous->actor_id === $request->user()->id, 403);
                if ($previous->request_hash !== $hash) {
                    $this->conflict('threshold_request_changed');
                }

                return response()->json(json_decode($previous->result, true))
                    ->header('Cache-Control', 'private, no-store');
            }
            $db->table('study_attempts')->whereIn('id', $change['attempt_ids'])
                ->orderBy('id')->lockForUpdate()->get(['id']);
            $impact = $this->impact($group, $change);
            if (! hash_equals($impact['preview_token'], $confirmation['preview_token'])) {
                $this->conflict('threshold_preview_changed');
            }
            $now = now();
            $db->table('study_threshold_submissions')->insert([
                'request_id' => $confirmation['request_id'], 'group_id' => $groupId,
                'actor_id' => $request->user()->id, 'request_hash' => $hash,
                'result' => json_encode($impact), 'created_at' => $now,
            ]);
            $db->table('study_attempts')->whereIn('id', $change['attempt_ids'])
                ->update(['completion_threshold' => $impact['target_threshold'],
                    'revision' => $db->raw('revision + 1'), 'updated_at' => $now]);
            $db->table('study_attempt_threshold_history')->insert(array_map(
                fn (array $student): array => [
                    'request_id' => $confirmation['request_id'], 'attempt_id' => $student['attempt_id'],
                    'before_threshold' => $student['before_threshold'],
                    'after_threshold' => $student['after_threshold'],
                    'covered_count' => $student['covered_count'],
                    'open_credited_count' => $student['open_credited_count'],
                    'required_count' => $student['required_count'],
                    'before_needed' => $student['before_needed'], 'after_needed' => $student['after_needed'],
                    'before_eligible' => $student['before_eligible'], 'after_eligible' => $student['after_eligible'],
                    'before_provisional' => $student['before_provisional'],
                    'after_provisional' => $student['after_provisional'],
                    'created_at' => $now,
                ], $impact['students']));
            $db->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'branch_id' => $group->branch_id,
                'event' => 'study_attempts.completion_threshold_applied', 'created_at' => $now,
                'details' => json_encode(['group_id' => $groupId, 'request_id' => $confirmation['request_id'],
                    'attempt_ids' => $change['attempt_ids'], 'target_threshold' => $impact['target_threshold'],
                    'reason' => $change['reason'], 'students' => $impact['students']]),
            ]);

            return response()->json($impact)->header('Cache-Control', 'private, no-store');
        });
    }

    private function change(Request $request): array
    {
        $data = $request->validate([
            'attempt_ids' => ['required', 'array', 'min:1', 'max:100'],
            'attempt_ids.*' => ['required', 'uuid', 'distinct'],
            'reason' => ['required', 'string', 'min:3', 'max:1000'],
        ]);
        $data['reason'] = trim($data['reason']);
        abort_if(mb_strlen($data['reason']) < 3, 422, 'أدخل سبب تطبيق النسبة على التسجيلات الحالية.');
        sort($data['attempt_ids']);

        return $data;
    }

    private function group(string $groupId, CenterPermissions $permissions, bool $lock = false): object
    {
        $query = DB::connection('tenant')->table('study_groups as groups')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->where('groups.id', $groupId)
            ->select(['groups.id', 'groups.revision', 'groups.plan_version_id',
                'groups.completion_threshold as group_threshold',
                'levels.completion_revision as level_completion_revision',
                'stages.completion_revision as stage_completion_revision',
                'courses.completion_revision as course_completion_revision', 'courses.branch_id'])
            ->selectRaw('COALESCE(groups.completion_threshold, levels.completion_threshold, stages.completion_threshold, courses.completion_threshold) AS target_threshold')
            ->selectRaw('(SELECT count(*) FROM study_group_requirements WHERE group_id = groups.id AND retired_at IS NULL) AS required_count');
        if ($lock) {
            $query->lockForUpdate();
        }
        $group = $query->first();
        abort_unless($group && $permissions->canInWorkspace('read', (int) $group->branch_id), 404);

        return $group;
    }

    private function impact(object $group, array $change): array
    {
        $rows = DB::connection('tenant')->table('study_attempts as attempts')
            ->join('students', 'students.id', '=', 'attempts.student_id')
            ->whereIn('attempts.id', $change['attempt_ids'])
            ->where('attempts.current_group_id', $group->id)
            ->where('attempts.status', 'active')
            ->select(['attempts.id', 'attempts.revision', 'attempts.completion_threshold',
                'attempts.plan_version_id', 'attempts.required_lectures',
                'students.name', 'students.student_number'])
            ->selectRaw(<<<'SQL'
COALESCE((SELECT json_agg(json_build_object('id', COALESCE(sessions.plan_lecture_id, sessions.group_requirement_id),
    'final', sessions.closed_at IS NOT NULL) ORDER BY entries.id)
    FROM study_attendance_entries AS entries
    JOIN study_sessions AS sessions ON sessions.id = entries.session_id
    WHERE entries.attempt_id = attempts.id AND entries.status = 'counted'
      AND sessions.status <> 'cancelled'), '[]'::json) AS attendance_rows,
COALESCE((SELECT json_agg(json_build_object('id', approvals.id,
    'source_lecture_ids', approvals.source_lecture_ids, 'target_lecture_ids', approvals.target_lecture_ids) ORDER BY approvals.id)
    FROM content_equivalences AS approvals
    WHERE approvals.target_plan_version_id = attempts.plan_version_id
      OR EXISTS (SELECT 1 FROM study_attempt_transfers AS transfers
          WHERE transfers.attempt_id = attempts.id
            AND transfers.to_plan_version_id = approvals.target_plan_version_id)
      OR EXISTS (SELECT 1 FROM study_attempt_plan_applications AS applications
          WHERE applications.attempt_id = attempts.id
            AND applications.to_plan_version_id = approvals.target_plan_version_id)), '[]'::json)::jsonb ||
COALESCE((SELECT json_agg(json_build_object('id', mappings.id,
    'source_lecture_ids', json_build_array(mappings.candidate_requirement_id),
    'target_lecture_ids', json_build_array(mappings.required_requirement_id)) ORDER BY mappings.id)
    FROM study_group_requirement_equivalences AS mappings
    WHERE mappings.required_group_id = attempts.current_group_id AND mappings.revoked_at IS NULL), '[]'::json)::jsonb AS approvals
SQL)
            ->orderBy('attempts.id')->get();
        abort_unless($rows->count() === count($change['attempt_ids']), 404);
        $requiredIds = DB::connection('tenant')->table('study_group_requirements')
            ->where('group_id', $group->id)->whereNull('retired_at')
            ->orderBy('number')->get(['id', 'plan_lecture_id'])
            ->map(fn (object $row): string => $row->plan_lecture_id ?? $row->id)->all();
        $groupRequired = count($requiredIds);
        abort_if($groupRequired === 0, 409, 'لا توجد محاضرات معتمدة للمجموعة.');
        $target = (int) $group->target_threshold;
        $students = $rows->map(function (object $row) use ($requiredIds, $target): array {
            $studentRequiredIds = $row->required_lectures === null ? $requiredIds
                : array_column(json_decode($row->required_lectures, true), 'id');
            $required = count($studentRequiredIds);
            $credits = StudyCoverageCredits::resolve(
                json_decode($row->attendance_rows, true), json_decode($row->approvals, true));
            $coveredIds = array_intersect($studentRequiredIds, array_keys($credits['lectures']));
            $covered = count($coveredIds);
            $finalCovered = count(array_filter($coveredIds,
                fn (string $id): bool => $credits['lectures'][$id] === true));
            $before = (int) $row->completion_threshold;
            $beforeEligible = $covered * 100 >= $before * $required;
            $afterEligible = $covered * 100 >= $target * $required;

            return ['attempt_id' => $row->id, 'name' => $row->name,
                'student_number' => (int) $row->student_number,
                'attempt_revision' => (int) $row->revision,
                'before_threshold' => $before, 'after_threshold' => $target,
                'covered_count' => $covered, 'open_credited_count' => $covered - $finalCovered,
                'required_count' => $required,
                'percentage' => round($covered * 100 / $required, 2),
                'before_needed' => (int) ceil($before * $required / 100),
                'after_needed' => (int) ceil($target * $required / 100),
                'before_eligible' => $beforeEligible, 'after_eligible' => $afterEligible,
                'before_provisional' => $beforeEligible && $finalCovered * 100 < $before * $required,
                'after_provisional' => $afterEligible && $finalCovered * 100 < $target * $required];
        })->all();
        abort_if(collect($students)->contains(fn (array $student): bool => $student['before_threshold'] === $target),
            422, 'إحدى المحاولات المختارة تستخدم النسبة الحالية بالفعل. أعد اختيار التسجيلات القديمة.');
        $token = hash('sha256', json_encode([$group->id, $group->revision,
            $group->level_completion_revision, $group->stage_completion_revision,
            $group->course_completion_revision, $group->group_threshold, $target,
            $change, $requiredIds, $rows->map(fn (object $row): array => [
                $row->id, $row->revision, $row->completion_threshold,
                $row->plan_version_id, $row->required_lectures,
                $row->attendance_rows, $row->approvals,
            ])->all()]));

        return ['group_id' => $group->id, 'target_threshold' => $target,
            'required_count' => $groupRequired, 'reason' => $change['reason'],
            'students' => $students, 'preview_token' => $token];
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
