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

class CenterStudyPlanApplicationController extends Controller
{
    public function options(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $filters = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'q' => ['nullable', 'string', 'max:100'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        $group = $this->group($groupId, $permissions);
        abort_unless($permissions->can('curriculum.manage', (int) $group->branch_id), 403);
        $page = (int) ($filters['page'] ?? 1);
        $search = trim($filters['q'] ?? '');
        $rows = DB::connection('tenant')->table('study_plan_versions as plans')
            ->where('plans.level_id', $group->level_id)
            ->where('plans.version', '>', (int) $group->plan_version)
            ->when($search !== '', fn ($query) => ctype_digit($search)
                ? $query->where('plans.version', (int) $search)
                : $query->whereRaw('plans.id::text ilike ?', ['%'.$search.'%']))
            ->select(['plans.id', 'plans.version', 'plans.created_at'])
            ->selectRaw('(SELECT count(*) FROM plan_lectures WHERE plan_version_id = plans.id) AS required_count')
            ->orderByDesc('plans.version')->orderByDesc('plans.id')
            ->offset(($page - 1) * 20)->limit(21)->get();

        return response()->json(['group' => ['id' => $group->id, 'name' => $group->name,
            'plan_version_id' => $group->plan_version_id, 'plan_version' => (int) $group->plan_version],
            'versions' => $rows->take(20), 'pagination' => ['page' => $page, 'has_more' => $rows->count() > 20]])
            ->header('Cache-Control', 'private, no-store');
    }

    public function preview(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $change = $this->change($request);
        $permissions = $request->attributes->get('center_permissions');
        $group = $this->group($groupId, $permissions);
        abort_unless($permissions->can('curriculum.manage', (int) $group->branch_id), 403);

        return response()->json($this->impact($group, $change))->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $change = $this->change($request);
        $confirmation = $request->validate([
            'group_revision' => ['required', 'integer', 'min:1'],
            'preview_token' => ['required', 'regex:/^[a-f0-9]{64}$/'],
            'request_id' => ['required', 'uuid'],
        ]);
        $hash = hash('sha256', json_encode([$groupId, $change, $confirmation['group_revision'], $confirmation['preview_token']]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $groupId, $change, $confirmation, $hash): JsonResponse {
            $group = $this->group($groupId, $permissions, true);
            abort_unless($permissions->can('curriculum.manage', (int) $group->branch_id), 403);
            $db = DB::connection('tenant');
            $previous = $db->table('study_plan_application_submissions')->where('request_id', $confirmation['request_id'])->first();
            if ($previous) {
                abort_unless($previous->group_id === $groupId && (int) $previous->actor_id === (int) $request->user()->id, 403);
                if ($previous->request_hash !== $hash) {
                    $this->conflict('plan_application_request_changed');
                }

                return response()->json(json_decode($previous->result, true))->header('Cache-Control', 'private, no-store');
            }
            if ((int) $group->revision !== (int) $confirmation['group_revision']) {
                $this->conflict('group_changed');
            }
            $db->table('study_attempts')->whereIn('id', $change['attempt_ids'])->orderBy('id')->lockForUpdate()->get(['id']);
            $impact = $this->impact($group, $change);
            if (! hash_equals($impact['preview_token'], $confirmation['preview_token'])) {
                $this->conflict('plan_application_preview_changed');
            }
            $now = now();
            $actor = $request->user();
            foreach ($impact['students'] as $student) {
                $db->table('study_attempt_plan_applications')->insert([
                    'id' => (string) Str::uuid(), 'attempt_id' => $student['attempt_id'], 'group_id' => $groupId,
                    'from_plan_version_id' => $student['from_plan_version_id'],
                    'to_plan_version_id' => $change['target_plan_version_id'],
                    'before_requirements' => json_encode($student['before_requirements']),
                    'after_requirements' => json_encode($impact['target_requirements']),
                    'before_coverage' => json_encode($student['before']),
                    'after_coverage' => json_encode($student['after']),
                    'completion_decision' => $student['completion_decision'] === null ? null : json_encode($student['completion_decision']),
                    'approval_ids' => json_encode($student['approval_ids']),
                    'reason' => $change['reason'], 'actor_id' => $actor->id, 'actor_name' => $actor->name,
                    'request_id' => $confirmation['request_id'], 'request_hash' => $hash, 'approved_at' => $now,
                ]);
                $db->table('study_attempts')->where('id', $student['attempt_id'])->update([
                    'plan_version_id' => $change['target_plan_version_id'],
                    'required_lectures' => json_encode($impact['target_requirements']),
                    'revision' => $student['attempt_revision'] + 1, 'updated_at' => $now,
                ]);
            }
            $db->table('study_plan_versions')->where('id', $change['target_plan_version_id'])
                ->whereNull('used_at')->update(['used_at' => $now]);
            $result = ['group_id' => $groupId, 'target_plan_version_id' => $change['target_plan_version_id'],
                'students' => $impact['students'], 'applied_count' => count($impact['students'])];
            $db->table('study_plan_application_submissions')->insert([
                'request_id' => $confirmation['request_id'], 'group_id' => $groupId,
                'actor_id' => $actor->id, 'request_hash' => $hash,
                'result' => json_encode($result), 'created_at' => $now,
            ]);
            $db->table('center_audit_logs')->insert([
                'actor_id' => $actor->id, 'branch_id' => $group->branch_id,
                'event' => 'study_attempts.plan_version_applied', 'created_at' => $now,
                'details' => json_encode(['group_id' => $groupId, 'request_id' => $confirmation['request_id'],
                    'target_plan_version_id' => $change['target_plan_version_id'], 'reason' => $change['reason'],
                    'students' => array_map(fn (array $student): array => [
                        'attempt_id' => $student['attempt_id'],
                        'from_plan_version_id' => $student['from_plan_version_id'],
                        'before' => $student['before'], 'after' => $student['after'],
                        'completion_decision_id' => $student['completion_decision']['id'] ?? null,
                    ], $impact['students'])]),
            ]);

            return response()->json($result, 201)->header('Cache-Control', 'private, no-store');
        });
    }

    private function change(Request $request): array
    {
        $data = $request->validate([
            'target_plan_version_id' => ['required', 'uuid'],
            'attempt_ids' => ['required', 'array', 'min:1', 'max:100'],
            'attempt_ids.*' => ['required', 'uuid', 'distinct'],
            'reason' => ['required', 'string', 'min:3', 'max:1000'],
        ]);
        $data['reason'] = trim($data['reason']);
        abort_if(mb_strlen($data['reason']) < 3, 422, 'أدخل سبب تطبيق إصدار الخطة.');
        sort($data['attempt_ids']);

        return $data;
    }

    private function group(string $groupId, CenterPermissions $permissions, bool $lock = false): object
    {
        $query = DB::connection('tenant')->table('study_groups as groups')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->join('study_plan_versions as plans', 'plans.id', '=', 'groups.plan_version_id')
            ->where('groups.id', $groupId)
            ->select(['groups.id', 'groups.name', 'groups.revision', 'groups.level_id', 'groups.plan_version_id',
                'courses.branch_id', 'plans.version as plan_version']);
        if ($lock) {
            $query->lockForUpdate();
        }
        $group = $query->first();
        abort_unless($group && $permissions->can('read', (int) $group->branch_id), 404);

        return $group;
    }

    private function impact(object $group, array $change): array
    {
        $db = DB::connection('tenant');
        $target = $db->table('study_plan_versions')->where('id', $change['target_plan_version_id'])
            ->where('level_id', $group->level_id)->first(['id', 'version', 'used_at']);
        abort_unless($target, 404);
        $targetRequirements = $db->table('plan_lectures')->where('plan_version_id', $target->id)
            ->orderBy('number')->get(['id', 'number', 'content', 'title', 'planned_hours'])
            ->map(fn (object $row): array => ['id' => $row->id, 'number' => (int) $row->number,
                'content' => $row->content, 'title' => $row->title,
                'planned_hours' => $row->planned_hours])->all();
        abort_if($targetRequirements === [], 409, 'إصدار الخطة الجديد بلا محاضرات.');
        $groupRequirements = $db->table('study_group_requirements')->where('group_id', $group->id)
            ->whereNull('retired_at')->orderBy('number')
            ->get(['id', 'plan_lecture_id', 'number', 'content', 'title', 'planned_hours'])
            ->map(fn (object $row): array => ['id' => $row->plan_lecture_id ?? $row->id,
                'number' => (int) $row->number, 'content' => $row->content,
                'title' => $row->title, 'planned_hours' => $row->planned_hours])->all();
        $rows = $db->table('study_attempts as attempts')
            ->join('students', 'students.id', '=', 'attempts.student_id')
            ->join('study_plan_versions as source_plans', 'source_plans.id', '=', 'attempts.plan_version_id')
            ->leftJoin('study_attempt_completion_decisions as decisions', 'decisions.attempt_id', '=', 'attempts.id')
            ->whereIn('attempts.id', $change['attempt_ids'])
            ->where('attempts.current_group_id', $group->id)
            ->whereIn('attempts.status', ['active', 'completed'])
            ->select(['attempts.id', 'attempts.plan_version_id', 'attempts.required_lectures',
                'attempts.revision', 'attempts.completion_threshold', 'source_plans.version as source_version',
                'students.name', 'students.student_number',
                'decisions.id as decision_id', 'decisions.approved_at', 'decisions.exceptional',
                'decisions.covered_count as decision_covered_count',
                'decisions.required_count as decision_required_count',
                'decisions.reason as decision_reason'])
            ->selectRaw(<<<'SQL'
COALESCE((SELECT json_agg(json_build_object('id', COALESCE(sessions.plan_lecture_id, sessions.group_requirement_id),
    'final', sessions.closed_at IS NOT NULL) ORDER BY entries.id)
    FROM study_attendance_entries AS entries JOIN study_sessions AS sessions ON sessions.id = entries.session_id
    WHERE entries.attempt_id = attempts.id AND entries.status = 'counted' AND sessions.status <> 'cancelled'), '[]'::json) AS attendance_rows
SQL)
            ->orderBy('attempts.id')->get();
        abort_unless($rows->count() === count($change['attempt_ids']), 404);
        abort_if($rows->contains(fn (object $row): bool => (int) $row->source_version >= (int) $target->version),
            422, 'اختر إصدارًا أحدث من الإصدار الحالي لكل محاولة مختارة.');
        $sourcePlanIds = $rows->pluck('plan_version_id')->all();
        $transferPlanIds = $db->table('study_attempt_transfers')->whereIn('attempt_id', $change['attempt_ids'])
            ->pluck('to_plan_version_id')->all();
        $appliedPlanIds = $db->table('study_attempt_plan_applications')->whereIn('attempt_id', $change['attempt_ids'])
            ->pluck('to_plan_version_id')->all();
        $approvalRows = $db->table('content_equivalences')
            ->whereIn('target_plan_version_id', array_unique([...$sourcePlanIds, ...$transferPlanIds,
                ...$appliedPlanIds, $target->id]))
            ->orderBy('id')->get(['id', 'source_lecture_ids', 'target_lecture_ids']);
        $approvals = $approvalRows->map(fn (object $row): array => ['id' => $row->id,
            'source_lecture_ids' => json_decode($row->source_lecture_ids, true),
            'target_lecture_ids' => json_decode($row->target_lecture_ids, true)])->all();
        $groupApprovals = $db->table('study_group_requirement_equivalences')
            ->where('required_group_id', $group->id)->whereNull('revoked_at')->orderBy('id')
            ->get(['id', 'candidate_requirement_id', 'required_requirement_id'])
            ->map(fn (object $row): array => ['id' => $row->id,
                'source_lecture_ids' => [$row->candidate_requirement_id],
                'target_lecture_ids' => [$row->required_requirement_id]])->all();
        $approvals = [...$approvals, ...$groupApprovals];
        $students = $rows->map(function (object $row) use ($groupRequirements, $targetRequirements, $approvals): array {
            $beforeRequirements = $row->required_lectures === null
                ? $groupRequirements : json_decode($row->required_lectures, true);
            $credits = StudyCoverageCredits::resolve(json_decode($row->attendance_rows, true), $approvals);
            $before = $this->coverage($beforeRequirements, $credits, (int) $row->completion_threshold);
            $after = $this->coverage($targetRequirements, $credits, (int) $row->completion_threshold);
            $approvalIds = collect([...$beforeRequirements, ...$targetRequirements])
                ->flatMap(fn (array $lecture): array => $credits['dependencies'][$lecture['id']] ?? [])
                ->unique()->sort()->values()->all();

            return ['attempt_id' => $row->id, 'attempt_revision' => (int) $row->revision,
                'name' => $row->name, 'student_number' => (int) $row->student_number,
                'from_plan_version_id' => $row->plan_version_id,
                'from_plan_version' => (int) $row->source_version,
                'completion_threshold' => (int) $row->completion_threshold,
                'before_requirements' => $beforeRequirements,
                'before' => $before, 'after' => $after, 'approval_ids' => $approvalIds,
                'completion_decision' => $row->decision_id === null ? null : [
                    'id' => $row->decision_id, 'approved_at' => $row->approved_at,
                    'exceptional' => (bool) $row->exceptional, 'reason' => $row->decision_reason,
                    'covered_count' => (int) $row->decision_covered_count,
                    'required_count' => (int) $row->decision_required_count,
                ]];
        })->all();
        $token = hash('sha256', json_encode([$group->id, $group->revision, $change,
            $target->id, $target->version, $targetRequirements, $groupRequirements,
            $rows->map(fn (object $row): array => [$row->id, $row->revision,
                $row->plan_version_id, $row->required_lectures, $row->completion_threshold,
                $row->attendance_rows, $row->decision_id, $row->approved_at])->all(), $approvals]));

        return ['group_revision' => (int) $group->revision,
            'target_plan_version_id' => $target->id, 'target_plan_version' => (int) $target->version,
            'target_requirements' => $targetRequirements,
            'students' => $students, 'preview_token' => $token];
    }

    private function coverage(array $requirements, array $credits, int $threshold): array
    {
        $covered = [];
        $open = [];
        $missing = [];
        foreach ($requirements as $lecture) {
            if (array_key_exists($lecture['id'], $credits['lectures'])) {
                $covered[] = (int) $lecture['number'];
                if (! $credits['lectures'][$lecture['id']]) {
                    $open[] = (int) $lecture['number'];
                }
            } else {
                $missing[] = (int) $lecture['number'];
            }
        }
        $required = count($requirements);
        $coveredCount = count($covered);
        $eligible = $required > 0 && $coveredCount * 100 >= $threshold * $required;

        return ['required_count' => $required, 'covered_count' => $coveredCount,
            'covered_numbers' => $covered, 'missing_numbers' => $missing, 'open_numbers' => $open,
            'percentage' => $required === 0 ? 0 : round($coveredCount * 100 / $required, 2),
            'needed' => (int) ceil($threshold * $required / 100), 'eligible' => $eligible,
            'provisional' => $eligible && count($open) > 0];
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
