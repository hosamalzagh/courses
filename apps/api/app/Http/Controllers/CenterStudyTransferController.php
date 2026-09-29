<?php

namespace App\Http\Controllers;

use App\Support\ActiveStudentAllocations;
use App\Support\ActiveStudentRefunds;
use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\EffectiveStudentPayments;
use App\Support\EffectiveStudyFees;
use App\Support\StudentMoney;
use App\Support\StudentPhotos;
use App\Support\StudyCoverageCredits;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudyTransferController extends Controller
{
    public function preview(Request $request, string $studentId, string $attemptId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($attemptId), 404);
        $data = $request->validate([
            'group_id' => ['required', 'uuid'],
            'transferred_on' => ['required', 'date_format:Y-m-d', 'before_or_equal:'.now('Africa/Cairo')->toDateString()],
            'history_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
        ]);
        $historyPage = (int) ($data['history_page'] ?? 1);
        $permissions = $request->attributes->get('center_permissions');
        $preview = $this->buildPreview($studentId, $attemptId, $data, $permissions);
        $preview['approval_count'] = count($preview['approval_ids']);
        unset($preview['approval_ids']);

        return response()->json(['preview' => $preview, ...$this->historyPage($attemptId, $permissions, $historyPage)])
            ->header('Cache-Control', 'private, no-store');
    }

    public function history(Request $request, string $studentId, string $attemptId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($attemptId), 404);
        $data = $request->validate(['history_page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $permissions = $request->attributes->get('center_permissions');
        $attempt = StudentPhotos::visibleStudent($studentId, $permissions, 'enrollment.manage')
            ->join('study_attempts as attempts', 'attempts.student_id', '=', 'students.id')
            ->where('attempts.id', $attemptId)
            ->whereExists(DB::connection('tenant')->table('student_branches')
                ->whereColumn('student_branches.student_id', 'students.id')
                ->whereColumn('student_branches.branch_id', 'attempts.branch_id')->selectRaw('1'))
            ->first(['attempts.branch_id']);
        abort_unless($attempt && $permissions->can('enrollment.manage', (int) $attempt->branch_id), 404);

        return response()->json($this->historyPage($attemptId, $permissions, (int) ($data['history_page'] ?? 1)))
            ->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request, string $studentId, string $attemptId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($attemptId), 404);
        $data = $request->validate([
            'group_id' => ['required', 'uuid'], 'group_revision' => ['required', 'integer', 'min:1'],
            'transferred_on' => ['required', 'date_format:Y-m-d', 'before_or_equal:'.now('Africa/Cairo')->toDateString()],
            'revision' => ['required', 'integer', 'min:1'],
            'preview_hash' => ['required', 'regex:/^[a-f0-9]{64}$/'],
            'reason' => ['required', 'string', 'max:2000'], 'request_id' => ['required', 'uuid'],
        ]);
        $data['reason'] = trim($data['reason']);
        abort_if($data['reason'] === '', 422, 'أدخل سبب النقل.');
        $requestHash = hash('sha256', json_encode([$studentId, $attemptId, $data['group_id'],
            (int) $data['group_revision'], $data['transferred_on'], (int) $data['revision'],
            $data['preview_hash'], $data['reason']]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $attemptId, $data, $requestHash): JsonResponse {
            $student = StudentPhotos::visibleStudent($studentId, $permissions, 'enrollment.manage')
                ->lockForUpdate()->first(['students.id', 'students.status']);
            abort_unless($student, 404);
            $prior = DB::connection('tenant')->table('study_attempt_transfers')->where('request_id', $data['request_id'])->first();
            if ($prior) {
                abort_unless($prior->attempt_id === $attemptId && (int) $prior->actor_id === (int) $request->user()->id
                    && $permissions->can('read', (int) $prior->from_branch_id)
                    && $permissions->can('read', (int) $prior->to_branch_id)
                    && $permissions->can('enrollment.manage', (int) $prior->to_branch_id), 404);
                if ($prior->request_hash !== $requestHash) {
                    $this->conflict('transfer_request_changed');
                }

                return response()->json(['transfer' => $this->historyRow($this->historyQuery()
                    ->where('transfers.id', $prior->id)->firstOrFail(), $permissions), 'replayed' => true]);
            }
            if ($student->status !== 'active') {
                $this->conflict('student_suspended');
            }
            $preview = $this->buildPreview($studentId, $attemptId, $data, $permissions, true);
            if ($preview['revision'] !== (int) $data['revision'] || $preview['group_revision'] !== (int) $data['group_revision']
                || $preview['hash'] !== $data['preview_hash']) {
                $this->conflict('transfer_preview_changed');
            }
            if (! $preview['equivalence_ready']) {
                $this->conflict('equivalence_required');
            }
            $attempt = DB::connection('tenant')->table('study_attempts')->where('id', $attemptId)->firstOrFail();
            $period = DB::connection('tenant')->table('study_attempt_group_periods')->where('attempt_id', $attemptId)
                ->whereNull('left_on')->lockForUpdate()->first();
            $waitlist = DB::connection('tenant')->table('study_attempt_waitlists')->where('attempt_id', $attemptId)
                ->whereNull('left_on')->lockForUpdate()->first();
            if (($period !== null) === ($waitlist !== null)
                || ($period !== null && $period->group_id !== $attempt->current_group_id)
                || ($waitlist !== null && $attempt->current_group_id !== null)) {
                $this->conflict('attempt_changed');
            }
            $start = $period?->joined_on ?? $waitlist?->entered_on;
            abort_if($data['transferred_on'] < $start, 422, 'تاريخ النقل يسبق بداية الارتباط الحالي.');
            if ($period !== null) {
                $recordedAttendance = DB::connection('tenant')->table('study_attendance_entries as entries')
                    ->join('study_sessions as sessions', 'sessions.id', '=', 'entries.session_id')
                    ->where('entries.attempt_id', $attemptId)->where('sessions.group_id', $period->group_id)
                    ->whereNotNull('entries.status')->where('sessions.status', '<>', 'cancelled')
                    ->whereRaw("(sessions.scheduled_at AT TIME ZONE 'Africa/Cairo')::date >= ?::date", [$data['transferred_on']])
                    ->exists();
                abort_if($recordedAttendance, 422, 'تاريخ النقل يسبق حضورًا مسجلًا أو يوافق يومه.');
            }
            $id = (string) Str::uuid();
            $now = now();
            if ($period !== null) {
                DB::connection('tenant')->table('study_attempt_group_periods')->where('id', $period->id)
                    ->update(['left_on' => $data['transferred_on']]);
            } else {
                DB::connection('tenant')->table('study_attempt_waitlists')->where('id', $waitlist->id)->update([
                    'to_group_id' => $data['group_id'], 'left_on' => $data['transferred_on'],
                    'left_by' => $request->user()->id, 'left_by_name' => $request->user()->name,
                    'exit_request_id' => $data['request_id'], 'exit_request_hash' => $requestHash, 'updated_at' => $now,
                ]);
            }
            DB::connection('tenant')->table('study_attempt_group_periods')->insert([
                'id' => (string) Str::uuid(), 'attempt_id' => $attemptId, 'group_id' => $data['group_id'],
                'joined_on' => $data['transferred_on'], 'created_at' => $now,
            ]);
            DB::connection('tenant')->table('study_attempts')->where('id', $attemptId)->update([
                'branch_id' => $preview['to']['branch_id'], 'level_id' => $preview['to']['level_id'],
                'plan_version_id' => $preview['to']['plan_version_id'], 'current_group_id' => $data['group_id'],
                'completion_threshold' => $preview['to']['completion_threshold'],
                'revision' => $attempt->revision + 1, 'updated_at' => $now,
            ]);
            DB::connection('tenant')->table('study_plan_versions')->where('id', $preview['to']['plan_version_id'])
                ->whereNull('used_at')->update(['used_at' => $now]);
            DB::connection('tenant')->table('study_attempt_transfers')->insert([
                'id' => $id, 'attempt_id' => $attemptId,
                'from_branch_id' => $attempt->branch_id, 'from_level_id' => $attempt->level_id,
                'from_plan_version_id' => $attempt->plan_version_id, 'from_group_id' => $attempt->current_group_id,
                'to_branch_id' => $preview['to']['branch_id'], 'to_level_id' => $preview['to']['level_id'],
                'to_plan_version_id' => $preview['to']['plan_version_id'], 'to_group_id' => $data['group_id'],
                'transferred_on' => $data['transferred_on'], 'approval_ids' => json_encode($preview['approval_ids']),
                'credited_count' => $preview['credited_count'], 'required_count' => $preview['required_count'],
                'credited_lectures' => json_encode($preview['credited_lectures']),
                'missing_lectures' => json_encode($preview['missing_lectures']),
                'reason' => $data['reason'], 'actor_id' => $request->user()->id, 'actor_name' => $request->user()->name,
                'request_id' => $data['request_id'], 'request_hash' => $requestHash, 'created_at' => $now,
            ]);
            foreach (array_unique([(int) $attempt->branch_id, (int) $preview['to']['branch_id']]) as $branchId) {
                DB::connection('tenant')->table('center_audit_logs')->insert([
                    'actor_id' => $request->user()->id, 'branch_id' => $branchId,
                    'event' => 'student.study_transferred',
                    'details' => json_encode(['kind' => 'study_attempt_transfers', 'record_id' => $id,
                        'student_id' => $studentId, 'attempt_id' => $attemptId,
                        'before' => $branchId === (int) $attempt->branch_id ? [
                            'branch_id' => $attempt->branch_id, 'level_id' => $attempt->level_id,
                            'plan_version_id' => $attempt->plan_version_id, 'group_id' => $attempt->current_group_id,
                        ] : null,
                        'after' => $branchId === (int) $preview['to']['branch_id'] ? $preview['to'] : null,
                        'transferred_on' => $data['transferred_on'], 'reason' => $data['reason']]),
                    'created_at' => $now,
                ]);
            }

            return response()->json(['transfer' => $this->historyRow($this->historyQuery()
                ->where('transfers.id', $id)->firstOrFail(), $permissions)], 201);
        })->header('Cache-Control', 'private, no-store');
    }

    private function buildPreview(string $studentId, string $attemptId, array $data, CenterPermissions $permissions, bool $lock = false): array
    {
        $branches = $permissions->isCenterManager() ? null : array_keys(array_filter($permissions->branchRoles,
            fn (array $roles): bool => in_array('enrollment.manage', CenterPermissions::actions($roles), true)));
        $sum = function (string $table, string $column, string $branchColumn) use ($branches): Builder {
            return DB::connection('tenant')->table($table)->whereColumn('student_id', 'attempts.student_id')
                ->when($branches !== null, fn (Builder $builder) => $builder->whereIn($branchColumn, $branches))
                ->selectRaw("COALESCE(SUM({$column}), 0)");
        };
        $used = ActiveStudentAllocations::query()->whereColumn('allocations.student_id', 'attempts.student_id')
            ->when($branches !== null, fn (Builder $builder) => $builder->whereIn('allocations.source_branch_id', $branches))
            ->selectRaw('COALESCE(SUM(allocations.amount), 0)');
        $refunded = ActiveStudentRefunds::query()->whereColumn('refunds.student_id', 'attempts.student_id')
            ->when($branches !== null, fn (Builder $builder) => $builder->whereIn('refunds.branch_id', $branches))
            ->selectRaw('COALESCE(SUM(refunds.amount), 0)');
        $paid = ActiveStudentAllocations::query()->whereColumn('allocations.student_id', 'attempts.student_id')
            ->when($branches !== null, fn (Builder $builder) => $builder->whereIn('allocations.target_branch_id', $branches))
            ->selectRaw('COALESCE(SUM(allocations.amount), 0)');
        $query = DB::connection('tenant')->table('study_attempts as attempts')
            ->join('students as account_owner', 'account_owner.id', '=', 'attempts.student_id')
            ->join('study_groups as groups', fn ($join) => $join->where('groups.id', $data['group_id']))
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->join('study_plan_versions as plans', 'plans.id', '=', 'groups.plan_version_id')
            ->where('attempts.id', $attemptId)->where('attempts.student_id', $studentId)
            ->select(['attempts.id', 'attempts.student_id', 'attempts.branch_id', 'attempts.level_id',
                'attempts.plan_version_id', 'attempts.current_group_id', 'attempts.status', 'attempts.revision',
                'account_owner.financial_account_revision',
                'groups.id as group_id', 'groups.name as group_name', 'groups.status as group_status',
                'groups.revision as group_revision', 'groups.level_id as group_level_id',
                'groups.plan_version_id as group_plan_version_id', 'plans.version as plan_version',
                'courses.branch_id as group_branch_id', 'levels.name as level_name'])
            ->selectRaw('COALESCE(groups.completion_threshold, levels.completion_threshold, stages.completion_threshold, courses.completion_threshold) AS completion_threshold')
            ->selectRaw(<<<'SQL'
EXISTS (SELECT 1 FROM student_branches WHERE student_id = attempts.student_id AND branch_id = attempts.branch_id) AS source_associated,
EXISTS (SELECT 1 FROM student_branches WHERE student_id = attempts.student_id AND branch_id = courses.branch_id) AS target_associated,
EXISTS (SELECT 1 FROM study_attempts AS other WHERE other.student_id = attempts.student_id AND other.level_id = groups.level_id AND other.status = 'active' AND other.id <> attempts.id) AS level_occupied,
COALESCE((SELECT joined_on::text FROM study_attempt_group_periods WHERE attempt_id = attempts.id AND left_on IS NULL),
    (SELECT entered_on::text FROM study_attempt_waitlists WHERE attempt_id = attempts.id AND left_on IS NULL)) AS current_start,
COALESCE((SELECT json_agg(json_build_object('id', COALESCE(sessions.plan_lecture_id, sessions.group_requirement_id),
    'final', sessions.closed_at IS NOT NULL) ORDER BY entries.id)
    FROM study_attendance_entries AS entries JOIN study_sessions AS sessions ON sessions.id = entries.session_id
    WHERE entries.attempt_id = attempts.id AND entries.status = 'counted' AND sessions.status <> 'cancelled'), '[]'::json) AS source_rows,
COALESCE((SELECT json_agg(json_build_object('id', COALESCE(requirements.plan_lecture_id, requirements.id),
    'number', requirements.number) ORDER BY requirements.number)
    FROM study_group_requirements AS requirements
    WHERE requirements.group_id = groups.id AND requirements.retired_at IS NULL), '[]'::json) AS target_lectures,
COALESCE((SELECT json_agg(json_build_object('id', approvals.id,
    'source_plan_version_id', approvals.source_plan_version_id,
    'target_plan_version_id', approvals.target_plan_version_id,
    'source_lecture_ids', approvals.source_lecture_ids, 'target_lecture_ids', approvals.target_lecture_ids) ORDER BY approvals.id)
    FROM content_equivalences AS approvals
    WHERE approvals.target_plan_version_id = groups.plan_version_id
      OR EXISTS (SELECT 1 FROM study_attempt_transfers AS transfers
          WHERE transfers.attempt_id = attempts.id
            AND transfers.to_plan_version_id = approvals.target_plan_version_id)), '[]'::json)::jsonb ||
COALESCE((SELECT json_agg(json_build_object('id', mappings.id,
    'source_plan_version_id', NULL, 'target_plan_version_id', NULL,
    'source_lecture_ids', json_build_array(mappings.candidate_requirement_id),
    'target_lecture_ids', json_build_array(mappings.required_requirement_id)) ORDER BY mappings.id)
    FROM study_group_requirement_equivalences AS mappings
    WHERE mappings.required_group_id = groups.id AND mappings.revoked_at IS NULL), '[]'::json)::jsonb AS approvals
SQL)
            ->selectRaw(<<<'SQL'
EXISTS (SELECT 1 FROM study_attendance_entries AS entries
    JOIN study_sessions AS sessions ON sessions.id = entries.session_id
    WHERE entries.attempt_id = attempts.id AND sessions.group_id = attempts.current_group_id
      AND entries.status IS NOT NULL AND sessions.status <> 'cancelled'
      AND (sessions.scheduled_at AT TIME ZONE 'Africa/Cairo')::date >= ?::date) AS recorded_after
SQL, [$data['transferred_on']]);
        $query->selectSub($sum('student_payments', EffectiveStudentPayments::amount(), 'branch_id'), 'received_total')
            ->selectSub($sum('study_attempt_fees', EffectiveStudyFees::amount('study_attempt_fees'), 'branch_id'), 'due_total')
            ->selectSub($used, 'used_total')->selectSub($refunded, 'refunded_total')->selectSub($paid, 'paid_total');
        $row = ($lock ? $query->lock('FOR UPDATE OF attempts, groups') : $query)->first();
        abort_unless($row && $permissions->can('enrollment.manage', (int) $row->branch_id), 404);
        $attempt = (object) ['id' => $row->id, 'revision' => $row->revision, 'branch_id' => $row->branch_id,
            'level_id' => $row->level_id, 'plan_version_id' => $row->plan_version_id,
            'current_group_id' => $row->current_group_id, 'status' => $row->status];
        $group = (object) ['id' => $row->group_id, 'name' => $row->group_name, 'status' => $row->group_status,
            'revision' => $row->group_revision, 'level_id' => $row->group_level_id,
            'plan_version_id' => $row->group_plan_version_id, 'plan_version' => $row->plan_version,
            'branch_id' => $row->group_branch_id, 'level_name' => $row->level_name,
            'completion_threshold' => $row->completion_threshold];
        abort_unless($group && $permissions->can('enrollment.manage', (int) $group->branch_id), 404);
        abort_unless($row->source_associated && $row->target_associated, 404);
        if ($attempt->status !== 'active' || $group->status === 'completed' || $attempt->current_group_id === $group->id) {
            $this->conflict('transfer_unavailable');
        }
        if ($row->level_occupied) {
            $this->conflict('target_level_already_active');
        }
        if ($row->current_start === null) {
            $this->conflict('attempt_changed');
        }
        abort_if($data['transferred_on'] < $row->current_start, 422, 'تاريخ النقل يسبق بداية الارتباط الحالي.');
        if ($row->recorded_after) {
            abort(422, 'تاريخ النقل يسبق حضورًا مسجلًا أو يوافق يومه.');
        }

        $sourceRows = json_decode($row->source_rows, true);
        $sourceIds = collect($sourceRows)->pluck('id')->unique()->values()->all();
        $targetLectures = collect(json_decode($row->target_lectures, true))->map(fn (array $entry) => (object) $entry);
        $approvals = json_decode($row->approvals, true);
        $credits = StudyCoverageCredits::resolve($sourceRows, $approvals);
        $credited = $credits['lectures'];
        $approvalIds = $targetLectures->flatMap(fn (object $lecture): array => $credits['dependencies'][$lecture->id] ?? [])
            ->unique()->sort()->values()->all();
        $directApproval = $attempt->plan_version_id === $group->plan_version_id;
        foreach ($approvals as $approval) {
            if ($approval['target_plan_version_id'] === $group->plan_version_id
                && $approval['source_plan_version_id'] === $attempt->plan_version_id) {
                $directApproval = true;
            }
        }
        $creditedLectures = $targetLectures->filter(fn ($lecture) => isset($credited[$lecture->id]));
        $missingLectures = $targetLectures->reject(fn ($lecture) => isset($credited[$lecture->id]));
        $balance = ['available_credit' => StudentMoney::format(StudentMoney::cents($row->received_total)
            - StudentMoney::cents($row->used_total) - StudentMoney::cents($row->refunded_total)),
            'debt' => StudentMoney::format(StudentMoney::cents($row->due_total) - StudentMoney::cents($row->paid_total))];
        $hash = hash('sha256', json_encode([$attempt->id, $attempt->revision, $attempt->branch_id,
            $attempt->level_id, $attempt->plan_version_id, $attempt->current_group_id,
            $group->id, $group->revision, $group->plan_version_id, $group->branch_id,
            $group->completion_threshold,
            $data['transferred_on'], $sourceIds, $approvalIds, $targetLectures->pluck('id')->all(),
            $creditedLectures->map(fn (object $lecture): array => [$lecture->id, $credited[$lecture->id]])->values()->all(),
            $missingLectures->pluck('id')->all(),
            $row->financial_account_revision, $balance]));

        return [
            'hash' => $hash, 'revision' => (int) $attempt->revision, 'group_revision' => (int) $group->revision,
            'to' => ['group_id' => $group->id, 'group_name' => $group->name,
                'branch_id' => (int) $group->branch_id, 'level_id' => $group->level_id,
                'level_name' => $group->level_name, 'plan_version_id' => $group->plan_version_id,
                'plan_version' => (int) $group->plan_version, 'completion_threshold' => (int) $group->completion_threshold],
            'required_count' => $targetLectures->count(), 'credited_count' => $creditedLectures->count(),
            'credited_lectures' => $creditedLectures->map(fn (object $lecture): array => ['id' => $lecture->id,
                'number' => $lecture->number, 'final' => $credited[$lecture->id]])->values()->all(),
            'missing_lectures' => $missingLectures->map(fn (object $lecture): array => ['id' => $lecture->id, 'number' => $lecture->number])->values()->all(),
            'credited_numbers' => $creditedLectures->pluck('number')->all(),
            'open_credited_numbers' => $creditedLectures->filter(fn (object $lecture): bool => ! $credited[$lecture->id])->pluck('number')->values()->all(),
            'missing_numbers' => $missingLectures->pluck('number')->all(),
            'approval_ids' => $approvalIds, 'equivalence_ready' => $directApproval,
            'balance' => $balance,
        ];
    }

    private function historyRow(object $row, CenterPermissions $permissions): array
    {
        $sourceVisible = $permissions->can('read', (int) $row->from_branch_id);

        return ['id' => $row->id, 'attempt_id' => $row->attempt_id,
            'from' => $sourceVisible ? ['branch_id' => (int) $row->from_branch_id,
                'branch_name' => $row->from_branch_name, 'level_name' => $row->from_level_name,
                'plan_version' => (int) $row->from_plan_version,
                'group_name' => $row->from_group_name,
                'level_id' => $row->from_level_id, 'plan_version_id' => $row->from_plan_version_id,
                'group_id' => $row->from_group_id] : null,
            'to' => $permissions->can('read', (int) $row->to_branch_id) ? [
                'branch_name' => $row->to_branch_name, 'level_name' => $row->to_level_name,
                'plan_version' => (int) $row->to_plan_version, 'group_name' => $row->to_group_name,
                'branch_id' => (int) $row->to_branch_id, 'level_id' => $row->to_level_id,
                'plan_version_id' => $row->to_plan_version_id, 'group_id' => $row->to_group_id] : null,
            'transferred_on' => $row->transferred_on,
            'reason' => $sourceVisible && $permissions->can('read', (int) $row->to_branch_id) ? $row->reason : null,
            'actor_name' => $sourceVisible && $permissions->can('read', (int) $row->to_branch_id) ? $row->actor_name : null,
            'credited_count' => (int) $row->credited_count, 'required_count' => (int) $row->required_count,
            'credited_lectures' => $row->credited_lectures === null ? null : json_decode($row->credited_lectures, true),
            'missing_lectures' => $row->missing_lectures === null ? null : json_decode($row->missing_lectures, true)];
    }

    private function historyPage(string $attemptId, CenterPermissions $permissions, int $page): array
    {
        $visibleBranches = array_keys(array_filter($permissions->branchRoles,
            fn (array $roles): bool => in_array('read', CenterPermissions::actions($roles), true)));
        $history = $this->historyQuery()->where('transfers.attempt_id', $attemptId)
            ->when(! $permissions->isCenterManager(), fn ($query) => $query
                ->whereIn('transfers.from_branch_id', $visibleBranches)->whereIn('transfers.to_branch_id', $visibleBranches))
            ->orderByDesc('transfers.transferred_on')->orderByDesc('transfers.created_at')->orderByDesc('transfers.id')
            ->offset(($page - 1) * 20)->limit(21)->get();

        return ['history' => $history->take(20)->map(fn (object $row): array => $this->historyRow($row, $permissions))->values(),
            'history_page' => $page, 'history_has_more' => $history->count() > 20];
    }

    private function historyQuery(): Builder
    {
        return DB::connection('tenant')->table('study_attempt_transfers as transfers')
            ->join('branches as from_branch', 'from_branch.id', '=', 'transfers.from_branch_id')
            ->join('levels as from_level', 'from_level.id', '=', 'transfers.from_level_id')
            ->join('study_plan_versions as from_plan', 'from_plan.id', '=', 'transfers.from_plan_version_id')
            ->leftJoin('study_groups as from_group', 'from_group.id', '=', 'transfers.from_group_id')
            ->join('branches as to_branch', 'to_branch.id', '=', 'transfers.to_branch_id')
            ->join('levels as to_level', 'to_level.id', '=', 'transfers.to_level_id')
            ->join('study_plan_versions as to_plan', 'to_plan.id', '=', 'transfers.to_plan_version_id')
            ->join('study_groups as to_group', 'to_group.id', '=', 'transfers.to_group_id')
            ->select(['transfers.*', 'from_branch.name as from_branch_name', 'from_level.name as from_level_name',
                'from_plan.version as from_plan_version', 'from_group.name as from_group_name',
                'to_branch.name as to_branch_name', 'to_level.name as to_level_name',
                'to_plan.version as to_plan_version', 'to_group.name as to_group_name']);
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
