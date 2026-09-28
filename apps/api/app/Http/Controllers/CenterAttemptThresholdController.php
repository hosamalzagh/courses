<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
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
        abort_unless($permissions->can('curriculum.manage', $group->branch_id), 403);

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
            abort_unless($permissions->can('curriculum.manage', $group->branch_id), 403);
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
                    'covered_count' => $student['covered_count'], 'required_count' => $impact['required_count'],
                    'before_needed' => $student['before_needed'], 'after_needed' => $student['after_needed'],
                    'before_eligible' => $student['before_eligible'], 'after_eligible' => $student['after_eligible'],
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
            ->selectRaw('(SELECT count(*) FROM plan_lectures WHERE plan_version_id = groups.plan_version_id) AS required_count');
        if ($lock) {
            $query->lockForUpdate();
        }
        $group = $query->first();
        abort_unless($group && $permissions->can('read', (int) $group->branch_id), 404);

        return $group;
    }

    private function impact(object $group, array $change): array
    {
        $rows = DB::connection('tenant')->table('study_attempts as attempts')
            ->join('students', 'students.id', '=', 'attempts.student_id')
            ->leftJoin('study_attendance_entries as entries', 'entries.attempt_id', '=', 'attempts.id')
            ->leftJoin('study_sessions as sessions', 'sessions.id', '=', 'entries.session_id')
            ->whereIn('attempts.id', $change['attempt_ids'])
            ->where('attempts.current_group_id', $group->id)
            ->where('attempts.plan_version_id', $group->plan_version_id)
            ->select(['attempts.id', 'attempts.revision', 'attempts.completion_threshold',
                'students.name', 'students.student_number'])
            ->selectRaw(<<<'SQL'
COALESCE(json_agg(DISTINCT sessions.plan_lecture_id ORDER BY sessions.plan_lecture_id)
    FILTER (WHERE entries.status = 'counted' AND sessions.status <> 'cancelled'
        AND sessions.plan_lecture_id IS NOT NULL), '[]'::json) AS credits
SQL)
            ->groupBy('attempts.id', 'attempts.revision', 'attempts.completion_threshold',
                'students.id', 'students.name', 'students.student_number')
            ->orderBy('attempts.id')->get();
        abort_unless($rows->count() === count($change['attempt_ids']), 404);
        $requiredIds = DB::connection('tenant')->table('plan_lectures')
            ->where('plan_version_id', $group->plan_version_id)->pluck('id')->all();
        $required = count($requiredIds);
        abort_if($required === 0, 409, 'لا توجد محاضرات معتمدة للمجموعة.');
        $target = (int) $group->target_threshold;
        $students = $rows->map(function (object $row) use ($requiredIds, $required, $target): array {
            $credits = json_decode($row->credits, true);
            $covered = count(array_intersect($requiredIds, $credits));
            $before = (int) $row->completion_threshold;

            return ['attempt_id' => $row->id, 'name' => $row->name,
                'student_number' => (int) $row->student_number,
                'attempt_revision' => (int) $row->revision,
                'before_threshold' => $before, 'after_threshold' => $target,
                'covered_count' => $covered, 'required_count' => $required,
                'percentage' => round($covered * 100 / $required, 2),
                'before_needed' => (int) ceil($before * $required / 100),
                'after_needed' => (int) ceil($target * $required / 100),
                'before_eligible' => $covered * 100 >= $before * $required,
                'after_eligible' => $covered * 100 >= $target * $required];
        })->all();
        abort_if(collect($students)->contains(fn (array $student): bool => $student['before_threshold'] === $target),
            422, 'إحدى المحاولات المختارة تستخدم النسبة الحالية بالفعل. أعد اختيار التسجيلات القديمة.');
        $token = hash('sha256', json_encode([$group->id, $group->revision,
            $group->level_completion_revision, $group->stage_completion_revision,
            $group->course_completion_revision, $group->group_threshold, $target,
            $change, $requiredIds, $rows->map(fn (object $row): array => [
                $row->id, $row->revision, $row->completion_threshold, $row->credits,
            ])->all()]));

        return ['group_id' => $group->id, 'target_threshold' => $target,
            'required_count' => $required, 'reason' => $change['reason'],
            'students' => $students, 'preview_token' => $token];
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
