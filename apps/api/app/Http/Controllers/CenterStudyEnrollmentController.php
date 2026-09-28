<?php

namespace App\Http\Controllers;

use App\Support\ActiveStudentAllocations;
use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\StudentAccountVersion;
use App\Support\StudentMoney;
use App\Support\StudentPhotos;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudyEnrollmentController extends Controller
{
    public function workspace(Request $request, string $studentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId), 404);
        $data = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'groups_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'q' => ['sometimes', 'string', 'max:100'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        $scope = $this->scope($permissions);
        $groupsPage = (int) ($data['groups_page'] ?? 1);
        $search = trim($data['q'] ?? '');
        $groups = DB::connection('tenant')->table('study_groups')
            ->join('levels', 'levels.id', '=', 'study_groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->join('branches', 'branches.id', '=', 'courses.branch_id')
            ->where('study_groups.status', '!=', 'completed')
            ->whereExists(DB::connection('tenant')->table('student_branches')
                ->whereColumn('student_branches.student_id', 'students.id')
                ->whereColumn('student_branches.branch_id', 'courses.branch_id')->selectRaw('1'))
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('courses.branch_id', $scope))
            ->when($search !== '', fn (Builder $query) => $query->where('study_groups.name', 'ILIKE', '%'.addcslashes($search, '%_\\').'%'))
            ->orderBy('study_groups.created_at')->orderBy('study_groups.id')
            ->offset(($groupsPage - 1) * 50)->limit(51)
            ->select(['study_groups.id', 'study_groups.name', 'study_groups.status', 'study_groups.revision',
                'study_groups.level_id', 'study_groups.plan_version_id', 'courses.branch_id',
                'branches.name as branch_name', 'levels.name as level_name'])
            ->selectRaw('study_groups.approved_price::text as approved_price');
        $payments = DB::connection('tenant')->table('student_payments')
            ->whereColumn('student_payments.student_id', 'students.id')
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('student_payments.branch_id', $scope))
            ->selectRaw('COALESCE(SUM(student_payments.amount), 0)');
        $fees = DB::connection('tenant')->table('study_attempt_fees')
            ->whereColumn('study_attempt_fees.student_id', 'students.id')
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('study_attempt_fees.branch_id', $scope))
            ->selectRaw('COALESCE(SUM(study_attempt_fees.net_amount), 0)');
        $used = ActiveStudentAllocations::query()->whereColumn('allocations.student_id', 'students.id')
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('allocations.source_branch_id', $scope))
            ->selectRaw('COALESCE(SUM(allocations.amount), 0)');
        $paid = ActiveStudentAllocations::query()->whereColumn('allocations.student_id', 'students.id')
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('allocations.target_branch_id', $scope))
            ->selectRaw('COALESCE(SUM(allocations.amount), 0)');
        $student = StudentPhotos::visibleStudent($studentId, $permissions, 'enrollment.manage')
            ->select(['students.id', 'students.name', 'students.student_number', 'students.status', 'students.financial_account_revision'])
            ->selectSub(DB::connection('tenant')->table('center_settings')->where('id', 1)->select('financial_currency'), 'currency')
            ->selectSub(DB::connection('tenant')->table('center_settings')->where('id', 1)->select('financial_currency_revision'), 'currency_revision')
            ->selectSub($payments, 'received_total')->selectSub($fees, 'due_total')
            ->selectSub($used, 'used_total')->selectSub($paid, 'paid_total')
            ->selectSub(DB::connection('tenant')->query()->fromSub($groups, 'choices')->selectRaw('json_agg(choices)'), 'group_choices')
            ->first();
        abort_unless($student, 404);
        $choices = collect(json_decode($student->group_choices ?? '[]', true));
        $page = (int) ($data['page'] ?? 1);
        $attempts = $this->attempts($studentId, $permissions)
            ->orderByDesc('study_attempts.created_at')->orderByDesc('study_attempts.id')
            ->offset(($page - 1) * 20)->limit(21)->get();

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(),
            'student' => ['id' => $student->id, 'name' => $student->name, 'student_number' => (int) $student->student_number,
                'status' => $student->status, 'currency' => $student->currency,
                'currency_revision' => (int) $student->currency_revision,
                'version' => StudentAccountVersion::forActor($student->id, $student->financial_account_revision, $request->user()->id)],
            'balance' => ['available_credit' => StudentMoney::format(StudentMoney::cents($student->received_total) - StudentMoney::cents($student->used_total)),
                'debt' => StudentMoney::format(StudentMoney::cents($student->due_total) - StudentMoney::cents($student->paid_total))],
            'groups' => $choices->take(50)->values(), 'attempts' => $attempts->take(20)->map(fn (object $row) => $this->present($row))->values(),
            'pagination' => ['page' => $page, 'has_more' => $attempts->count() > 20,
                'groups_page' => $groupsPage, 'groups_has_more' => $choices->count() > 50],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request, string $studentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId), 404);
        $data = $request->validate([
            'group_id' => ['required', 'uuid'], 'group_revision' => ['required', 'integer', 'min:1'],
            'currency_revision' => ['required', 'integer', 'min:1'],
            'joined_on' => ['required', 'date_format:Y-m-d'],
            'discount' => ['required', 'numeric', 'decimal:0,2', 'min:0', 'max:9999999999.99'],
            'discount_reason' => ['present', 'nullable', 'string', 'max:2000'],
            'version' => ['required', 'regex:/^[a-f0-9]{64}$/'], 'request_id' => ['required', 'uuid'],
        ]);
        $data['discount'] = $this->amount($data['discount']);
        $data['discount_reason'] = trim($data['discount_reason'] ?? '') ?: null;
        abort_if($data['discount'] !== '0.00' && $data['discount_reason'] === null, 422, 'أدخل سبب الخصم.');
        abort_if($data['discount'] === '0.00' && $data['discount_reason'] !== null, 422, 'لا تسجل سبب خصم دون خصم.');
        $hash = hash('sha256', json_encode([$studentId, $data['group_id'], (int) $data['group_revision'], (int) $data['currency_revision'],
            $data['joined_on'], $data['discount'], $data['discount_reason']]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $data, $hash): JsonResponse {
            $group = DB::connection('tenant')->table('study_groups')
                ->join('levels', 'levels.id', '=', 'study_groups.level_id')
                ->join('stages', 'stages.id', '=', 'levels.stage_id')
                ->join('courses', 'courses.id', '=', 'stages.course_id')
                ->where('study_groups.id', $data['group_id'])
                ->lockForUpdate()
                ->first(['study_groups.id', 'study_groups.level_id', 'study_groups.plan_version_id',
                    'study_groups.approved_price', 'study_groups.revision', 'study_groups.status', 'courses.branch_id',
                    DB::raw('COALESCE(study_groups.completion_threshold, levels.completion_threshold, stages.completion_threshold, courses.completion_threshold) AS completion_threshold')]);
            abort_unless($group && $permissions->can('enrollment.manage', (int) $group->branch_id), 404);
            $student = StudentPhotos::visibleStudent($studentId, $permissions, 'enrollment.manage')
                ->whereExists(DB::connection('tenant')->table('student_branches')
                    ->whereColumn('student_branches.student_id', 'students.id')
                    ->where('student_branches.branch_id', $group->branch_id)->selectRaw('1'))
                ->lockForUpdate()->first(['students.id', 'students.status', 'students.financial_account_revision']);
            abort_unless($student, 404);
            $existing = DB::connection('tenant')->table('study_attempts')->where('request_id', $data['request_id'])->first();
            if ($existing !== null) {
                abort_unless($existing->student_id === $studentId && $existing->created_by === $request->user()->id, 403);
                if ($existing->request_hash !== $hash) {
                    $this->conflict('enrollment_request_changed');
                }

                return response()->json(['attempt' => $this->present($this->attempts($studentId, $permissions)->where('study_attempts.id', $existing->id)->firstOrFail())]);
            }
            if ($student->status !== 'active') {
                $this->conflict('student_suspended');
            }
            if ((int) $group->revision !== (int) $data['group_revision']) {
                $this->conflict('group_changed');
            }
            abort_if($group->status === 'completed', 409, 'اكتملت المجموعة؛ اختر مجموعة أخرى.');
            if (! hash_equals(StudentAccountVersion::forActor($studentId, $student->financial_account_revision, $request->user()->id), $data['version'])) {
                $this->conflict('student_account_changed');
            }
            abort_if(DB::connection('tenant')->table('study_attempts')->where('student_id', $studentId)
                ->where('level_id', $group->level_id)->where('status', 'active')->exists(), 409,
                'للطالب محاولة نشطة في هذا المستوى.');
            abort_if($data['discount'] !== '0.00' && ! $permissions->can('fees.discount', (int) $group->branch_id), 403);
            $price = $this->amount($group->approved_price);
            $discountCents = $this->cents($data['discount']);
            $priceCents = $this->cents($price);
            abort_if($discountCents > $priceCents, 422, 'الخصم أكبر من السعر المعتمد.');
            $settings = DB::connection('tenant')->table('center_settings')->where('id', 1)->lockForUpdate()->first();
            abort_unless($settings, 503);
            if ((int) $settings->financial_currency_revision !== (int) $data['currency_revision']) {
                $this->conflict('currency_changed');
            }
            abort_if($settings->financial_currency === null, 409, 'اختر عملة المركز قبل تسجيل الرسوم.');
            $attemptId = (string) Str::uuid();
            $feeId = (string) Str::uuid();
            $now = now();
            DB::connection('tenant')->table('study_attempts')->insert([
                'id' => $attemptId, 'student_id' => $studentId, 'level_id' => $group->level_id,
                'plan_version_id' => $group->plan_version_id, 'current_group_id' => $group->id,
                'branch_id' => $group->branch_id, 'joined_on' => $data['joined_on'], 'status' => 'active',
                'completion_threshold' => $group->completion_threshold,
                'created_by' => $request->user()->id, 'created_by_name' => $request->user()->name,
                'request_id' => $data['request_id'], 'request_hash' => $hash, 'created_at' => $now, 'updated_at' => $now,
            ]);
            DB::connection('tenant')->table('study_attempt_group_periods')->insert([
                'id' => (string) Str::uuid(), 'attempt_id' => $attemptId, 'group_id' => $group->id,
                'joined_on' => $data['joined_on'], 'created_at' => $now,
            ]);
            DB::connection('tenant')->table('study_attempt_fees')->insert([
                'id' => $feeId, 'attempt_id' => $attemptId, 'student_id' => $studentId,
                'branch_id' => $group->branch_id, 'original_price' => $price,
                'discount' => $data['discount'], 'net_amount' => $this->money($priceCents - $discountCents),
                'currency' => $settings->financial_currency, 'discount_reason' => $data['discount_reason'],
                'actor_id' => $request->user()->id, 'actor_name' => $request->user()->name, 'created_at' => $now,
            ]);
            DB::connection('tenant')->table('students')->where('id', $studentId)->update([
                'financial_account_revision' => $student->financial_account_revision + 1,
            ]);
            if ($settings->financial_currency_locked_at === null) {
                DB::connection('tenant')->table('center_settings')->where('id', 1)->update([
                    'financial_currency_locked_at' => $now, 'updated_at' => $now,
                ]);
            }
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'branch_id' => $group->branch_id, 'event' => 'student.enrolled',
                'details' => json_encode(['student_id' => $studentId, 'attempt_id' => $attemptId, 'group_id' => $group->id,
                    'plan_version_id' => $group->plan_version_id, 'joined_on' => $data['joined_on'],
                    'fee_id' => $feeId, 'original_price' => $price, 'discount' => $data['discount'],
                    'discount_reason' => $data['discount_reason'], 'net_amount' => $this->money($priceCents - $discountCents),
                    'currency' => $settings->financial_currency]), 'created_at' => $now,
            ]);

            return response()->json(['attempt' => $this->present($this->attempts($studentId, $permissions)->where('study_attempts.id', $attemptId)->firstOrFail())], 201);
        })->header('Cache-Control', 'private, no-store');
    }

    private function attempts(string $studentId, CenterPermissions $permissions): Builder
    {
        return DB::connection('tenant')->table('study_attempts')
            ->join('study_groups', 'study_groups.id', '=', 'study_attempts.current_group_id')
            ->join('levels', 'levels.id', '=', 'study_attempts.level_id')
            ->join('study_attempt_fees as fees', 'fees.attempt_id', '=', 'study_attempts.id')
            ->leftJoin('student_event_notes as note', function ($join) use ($permissions): void {
                $join->on('note.event_id', '=', 'study_attempts.id')->on('note.branch_id', '=', 'fees.branch_id')
                    ->where('note.event_type', 'study_attempt');
                if (! $permissions->isCenterManager()) {
                    $readableBranches = array_keys(array_filter($permissions->branchRoles,
                        fn (array $roles): bool => in_array('read', CenterPermissions::actions($roles), true)));
                    $join->whereIn('note.branch_id', $readableBranches);
                }
            })
            ->where('study_attempts.student_id', $studentId)
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('study_attempts.branch_id', $this->scope($permissions)))
            ->select(['study_attempts.id', 'study_attempts.level_id', 'study_attempts.plan_version_id',
                'study_attempts.current_group_id', 'study_attempts.branch_id', 'study_attempts.joined_on',
                'study_attempts.status', 'study_attempts.created_at', 'study_groups.name as group_name', 'levels.name as level_name'])
            ->selectRaw('(SELECT count(*) FROM plan_lectures WHERE plan_version_id = study_attempts.plan_version_id) AS requirements_count')
            ->addSelect(['fees.id as fee_id', 'fees.original_price', 'fees.discount', 'fees.net_amount',
                'fees.currency', 'fees.discount_reason', 'fees.actor_name', 'fees.branch_id as event_branch_id',
                'note.id as note_id', 'note.body as note_body', 'note.important as note_important',
                'note.revision as note_revision', 'note.updated_by_name as note_updated_by_name']);
    }

    private function present(object $row): array
    {
        return ['id' => $row->id, 'level_id' => $row->level_id, 'plan_version_id' => $row->plan_version_id,
            'current_group_id' => $row->current_group_id, 'branch_id' => (int) $row->branch_id,
            'event_branch_id' => (int) $row->event_branch_id,
            'joined_on' => $row->joined_on, 'status' => $row->status, 'created_at' => $row->created_at,
            'group_name' => $row->group_name, 'level_name' => $row->level_name,
            'requirements_count' => (int) $row->requirements_count,
            'fee' => ['id' => $row->fee_id, 'original_price' => $row->original_price,
                'discount' => $row->discount, 'net_amount' => $row->net_amount,
                'currency' => $row->currency, 'discount_reason' => $row->discount_reason,
                'actor_name' => $row->actor_name],
            'note' => $row->note_id === null ? null : ['id' => $row->note_id,
                'body' => $row->note_body, 'important' => (bool) $row->note_important,
                'revision' => (int) $row->note_revision, 'updated_by_name' => $row->note_updated_by_name]];
    }

    private function scope(CenterPermissions $permissions): array
    {
        return array_keys(array_filter($permissions->branchRoles,
            fn (array $roles): bool => in_array('enrollment.manage', CenterPermissions::actions($roles), true)));
    }

    private function amount(string|int|float $value): string
    {
        $text = (string) $value;
        abort_unless(preg_match('/^\d{1,10}(?:\.\d{1,2})?$/', $text) === 1, 422);
        [$whole, $fraction] = array_pad(explode('.', $text, 2), 2, '');

        return (string) ((int) $whole).'.'.str_pad($fraction, 2, '0');
    }

    private function cents(string $amount): int
    {
        [$whole, $fraction] = explode('.', $amount);

        return (int) $whole * 100 + (int) $fraction;
    }

    private function money(int $cents): string
    {
        return intdiv($cents, 100).'.'.str_pad((string) ($cents % 100), 2, '0', STR_PAD_LEFT);
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
