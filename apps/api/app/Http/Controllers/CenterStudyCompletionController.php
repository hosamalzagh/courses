<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\StudyCoverageCredits;
use App\Support\StudyPeriodRequirements;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudyCompletionController extends Controller
{
    public function preview(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $data = $this->input($request);
        $permissions = $request->attributes->get('center_permissions');
        $group = $this->group($groupId, $permissions);
        $snapshot = $this->snapshot($group, $data);

        return response()->json($snapshot)->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $data = $this->input($request, true);
        $hash = hash('sha256', json_encode([$groupId, $data], JSON_THROW_ON_ERROR));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $groupId, $data, $hash): JsonResponse {
            $group = $this->group($groupId, $permissions, true);
            $db = DB::connection('tenant');
            $prior = $db->table('study_completion_submissions')->where('request_id', $data['request_id'])->first();
            if ($prior) {
                abort_unless($prior->group_id === $groupId && (int) $prior->actor_id === $request->user()->id, 403);
                if ($prior->request_hash !== $hash) {
                    $this->conflict('completion_request_changed');
                }

                return response()->json(json_decode($prior->result, true))->header('Cache-Control', 'private, no-store');
            }
            if ((int) $group->revision !== (int) $data['group_revision']) {
                $this->conflict('group_changed');
            }
            $snapshot = $this->snapshot($group, $data, true);
            if (! hash_equals($snapshot['preview_token'], $data['preview_token'])) {
                $this->conflict('completion_preview_changed');
            }
            if ($data['complete_group'] && $snapshot['open_sessions'] !== []) {
                $this->conflict('group_has_open_sessions');
            }
            if (array_filter($snapshot['students'], fn (array $student): bool => $student['open_numbers'] !== [])) {
                $this->conflict('completion_attendance_open');
            }

            $now = now();
            $actor = $request->user();
            if ($data['complete_group']) {
                $db->table('study_groups')->where('id', $groupId)->update([
                    'status' => 'completed', 'revision' => $group->revision + 1,
                    'completed_at' => $now, 'completed_by' => $actor->id,
                    'completed_by_name' => $actor->name, 'updated_at' => $now,
                ]);
                $this->audit($actor->id, $group->branch_id, 'study_group.completed', [
                    'group_id' => $groupId, 'before' => $group->status, 'after' => 'completed',
                    'open_sessions' => [], 'selected_attempt_ids' => array_column($snapshot['students'], 'attempt_id'),
                ]);
            }
            $completionDate = now('Africa/Cairo')->toDateString();
            foreach ($snapshot['students'] as $student) {
                $period = $db->table('study_attempt_group_periods')
                    ->where('attempt_id', $student['attempt_id'])->where('group_id', $groupId)
                    ->whereNull('left_on')->whereDate('joined_on', '<=', $completionDate)
                    ->lockForUpdate()->first(['id']);
                if ($period === null || ! StudyPeriodRequirements::close($period->id, $groupId, $completionDate)) {
                    $this->conflict('completion_attempt_changed');
                }
                $db->table('study_attempt_completion_decisions')->insert([
                    'id' => (string) Str::uuid(), 'attempt_id' => $student['attempt_id'],
                    'group_id' => $groupId, 'student_id' => $student['student_id'], 'branch_id' => $group->branch_id,
                    'exceptional' => $student['exceptional'], 'reason' => $student['reason'],
                    'covered_count' => $student['covered_count'], 'required_count' => $student['required_count'],
                    'completion_threshold' => $student['completion_threshold'],
                    'covered_numbers' => json_encode($student['covered_numbers']),
                    'missing_numbers' => json_encode($student['missing_numbers']),
                    'approved_by' => $actor->id, 'approved_by_name' => $actor->name,
                    'approved_at' => $now, 'request_id' => $data['request_id'],
                ]);
                $db->table('study_attempts')->where('id', $student['attempt_id'])->update([
                    'status' => 'completed', 'revision' => DB::raw('revision + 1'), 'updated_at' => $now,
                ]);
                $this->audit($actor->id, $group->branch_id, 'study_attempt.completed', [
                    'group_id' => $groupId, 'attempt_id' => $student['attempt_id'],
                    'student_id' => $student['student_id'], 'before' => 'active', 'after' => 'completed',
                    'exceptional' => $student['exceptional'], 'reason' => $student['reason'],
                    'covered_count' => $student['covered_count'], 'required_count' => $student['required_count'],
                    'completion_threshold' => $student['completion_threshold'],
                    'missing_numbers' => $student['missing_numbers'],
                ]);
            }
            $result = ['group_status' => $data['complete_group'] ? 'completed' : $group->status,
                'group_revision' => $group->revision + (int) $data['complete_group'],
                'completed_attempt_ids' => array_column($snapshot['students'], 'attempt_id')];
            $db->table('study_completion_submissions')->insert([
                'request_id' => $data['request_id'], 'group_id' => $groupId, 'actor_id' => $actor->id,
                'request_hash' => $hash, 'result' => json_encode($result), 'created_at' => $now,
            ]);

            return response()->json($result)->header('Cache-Control', 'private, no-store');
        });
    }

    private function input(Request $request, bool $confirm = false): array
    {
        $data = $request->validate([
            'complete_group' => ['required', 'boolean'],
            'decisions' => ['present', 'array', 'max:200'],
            'decisions.*.attempt_id' => ['required', 'uuid', 'distinct'],
            'decisions.*.exception_reason' => ['nullable', 'string', 'min:3', 'max:1000'],
            ...($confirm ? [
                'group_revision' => ['required', 'integer', 'min:1'],
                'preview_token' => ['required', 'string', 'size:64'],
                'request_id' => ['required', 'uuid'],
            ] : []),
        ]);
        $data['decisions'] = array_map(fn (array $decision): array => [
            'attempt_id' => $decision['attempt_id'],
            'exception_reason' => trim($decision['exception_reason'] ?? '') ?: null,
        ], $data['decisions']);
        usort($data['decisions'], fn (array $a, array $b): int => strcmp($a['attempt_id'], $b['attempt_id']));

        return $data;
    }

    private function group(string $groupId, CenterPermissions $permissions, bool $lock = false): object
    {
        $query = DB::connection('tenant')->table('study_groups as groups')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->where('groups.id', $groupId)
            ->select(['groups.id', 'groups.name', 'groups.status', 'groups.revision', 'groups.plan_version_id', 'courses.branch_id']);
        if ($lock) {
            $query->lock('FOR UPDATE OF groups');
        }
        $group = $query->first();
        abort_unless($group && $permissions->can('read', (int) $group->branch_id), 404);
        abort_unless($permissions->can('study.complete', (int) $group->branch_id), 403);

        return $group;
    }

    private function snapshot(object $group, array $data, bool $lock = false): array
    {
        if ($group->status === 'waiting' || ($data['complete_group'] && $group->status !== 'started')
            || (! $data['complete_group'] && $group->status !== 'completed')) {
            $this->conflict('group_changed');
        }
        if (! $data['complete_group'] && $data['decisions'] === []) {
            $this->conflict('completion_selection_empty');
        }
        $db = DB::connection('tenant');
        $requirements = $db->table('study_group_requirements')->where('group_id', $group->id)
            ->whereNull('retired_at')->orderBy('number')->get(['id', 'plan_lecture_id', 'number']);
        $required = $requirements->pluck('number')->map(fn ($number): int => (int) $number)->all();
        $openSessions = $db->table('study_sessions as sessions')
            ->join('study_group_requirements as lectures', 'lectures.id', '=', 'sessions.group_requirement_id')
            ->where('sessions.group_id', $group->id)->where('sessions.status', '<>', 'cancelled')
            ->whereNull('sessions.closed_at')->orderBy('lectures.number')->pluck('lectures.number')->all();
        $ids = array_column($data['decisions'], 'attempt_id');
        $students = [];
        if ($ids !== []) {
            $query = $db->table('study_attempts as attempts')
                ->join('students', 'students.id', '=', 'attempts.student_id')
                ->where('attempts.current_group_id', $group->id)->where('attempts.status', 'active')
                ->whereIn('attempts.id', $ids)
                ->select(['attempts.id as attempt_id', 'attempts.student_id', 'attempts.completion_threshold',
                    'students.name', 'students.student_number'])
                ->selectRaw(<<<'SQL'
COALESCE((SELECT json_agg(json_build_object('id', COALESCE(sessions.plan_lecture_id, sessions.group_requirement_id),
    'final', sessions.closed_at IS NOT NULL) ORDER BY entries.id)
    FROM study_attendance_entries AS entries
    JOIN study_sessions AS sessions ON sessions.id = entries.session_id
    WHERE entries.attempt_id = attempts.id AND entries.status = 'counted' AND sessions.status <> 'cancelled'), '[]'::json) AS attendance_rows,
COALESCE((SELECT json_agg(json_build_object('id', approvals.id,
    'source_lecture_ids', approvals.source_lecture_ids, 'target_lecture_ids', approvals.target_lecture_ids))
    FROM content_equivalences AS approvals
    WHERE approvals.target_plan_version_id = attempts.plan_version_id
      OR EXISTS (SELECT 1 FROM study_attempt_transfers AS transfers
          WHERE transfers.attempt_id = attempts.id
            AND transfers.to_plan_version_id = approvals.target_plan_version_id)), '[]'::json)::jsonb ||
COALESCE((SELECT json_agg(json_build_object('id', mappings.id,
    'source_lecture_ids', json_build_array(mappings.candidate_requirement_id),
    'target_lecture_ids', json_build_array(mappings.required_requirement_id)) ORDER BY mappings.id)
    FROM study_group_requirement_equivalences AS mappings
    WHERE mappings.required_group_id = attempts.current_group_id AND mappings.revoked_at IS NULL), '[]'::json)::jsonb AS approvals,
(SELECT periods.joined_on FROM study_attempt_group_periods AS periods
    WHERE periods.attempt_id = attempts.id AND periods.group_id = attempts.current_group_id
      AND periods.left_on IS NULL LIMIT 1) AS period_joined_on
SQL)
                ->orderBy('attempts.id');
            if ($lock) {
                $query->lock('FOR UPDATE OF attempts');
            }
            $rows = $query->get();
            if ($rows->count() !== count($ids)) {
                $this->conflict('completion_attempt_changed');
            }
            $reasons = array_column($data['decisions'], 'exception_reason', 'attempt_id');
            foreach ($rows as $row) {
                if ($row->period_joined_on === null) {
                    $this->conflict('completion_attempt_changed');
                }
                if ($row->period_joined_on > now('Africa/Cairo')->toDateString()) {
                    $this->conflict('completion_before_join_date');
                }
                $credits = StudyCoverageCredits::resolve(json_decode($row->attendance_rows, true), json_decode($row->approvals, true));
                $covered = $requirements->filter(fn (object $item): bool => array_key_exists(
                    $item->plan_lecture_id ?? $item->id, $credits['lectures']))
                    ->pluck('number')->map(fn ($number): int => (int) $number)->all();
                $open = $requirements->filter(fn (object $item): bool => array_key_exists(
                    $item->plan_lecture_id ?? $item->id, $credits['lectures'])
                    && ! $credits['lectures'][$item->plan_lecture_id ?? $item->id])
                    ->pluck('number')->map(fn ($number): int => (int) $number)->all();
                $missing = array_values(array_diff($required, $covered));
                $eligible = $required !== [] && count($covered) * 100 >= (int) $row->completion_threshold * count($required);
                $reason = $reasons[$row->attempt_id];
                if (! $eligible && ($reason === null || mb_strlen($reason) < 3)) {
                    $this->conflict('completion_exception_reason_required');
                }
                if ($eligible && $reason !== null) {
                    $this->conflict('completion_reason_unneeded');
                }
                $students[] = [
                    'attempt_id' => $row->attempt_id, 'student_id' => $row->student_id,
                    'name' => $row->name, 'student_number' => $row->student_number,
                    'covered_numbers' => $covered, 'missing_numbers' => $missing, 'open_numbers' => $open,
                    'covered_count' => count($covered), 'required_count' => count($required),
                    'completion_threshold' => (int) $row->completion_threshold,
                    'percentage' => $required === [] ? 0 : round(count($covered) * 100 / count($required), 2),
                    'exceptional' => ! $eligible, 'reason' => $reason,
                ];
            }
        }
        $token = hash('sha256', json_encode([$group->id, $group->revision, $group->status,
            $data['complete_group'], $required, $openSessions, $students], JSON_THROW_ON_ERROR));

        return ['group' => ['id' => $group->id, 'name' => $group->name,
            'status' => $group->status, 'revision' => $group->revision],
            'open_sessions' => $openSessions, 'students' => $students, 'preview_token' => $token];
    }

    private function audit(int $actorId, int $branchId, string $event, array $details): void
    {
        DB::connection('tenant')->table('center_audit_logs')->insert([
            'actor_id' => $actorId, 'branch_id' => $branchId, 'event' => $event,
            'details' => json_encode($details, JSON_THROW_ON_ERROR), 'created_at' => now(),
        ]);
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
