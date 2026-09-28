<?php

namespace App\Http\Controllers;

use App\Support\ActiveStudentAllocations;
use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\EffectiveStudyFees;
use App\Support\StudentAccountVersion;
use App\Support\StudentMoney;
use App\Support\StudentPhotos;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudentAllocationController extends Controller
{
    public function options(Request $request, string $studentId, string $paymentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($paymentId), 404);
        $data = $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'history_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'allocation_id' => ['sometimes', 'uuid']]);
        $permissions = $request->attributes->get('center_permissions');
        $page = (int) ($data['page'] ?? 1);
        $historyPage = (int) ($data['history_page'] ?? 1);
        $readableBranches = array_keys(array_filter($permissions->branchRoles,
            fn (array $roles): bool => in_array('finance.read', CenterPermissions::actions($roles), true)));
        $historyQuery = DB::connection('tenant')->table('student_payment_allocations as allocations')
            ->join('study_attempt_fees as fees', 'fees.id', '=', 'allocations.fee_id')
            ->join('branches as target_branches', 'target_branches.id', '=', 'allocations.target_branch_id')
            ->leftJoin('student_payment_allocation_reversals as reversals', 'reversals.allocation_id', '=', 'allocations.id')
            ->whereColumn('allocations.payment_id', 'payments.id')->where('allocations.student_id', $studentId)
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('allocations.target_branch_id', $readableBranches))
            ->when(isset($data['allocation_id']), fn ($query) => $query->where('allocations.id', $data['allocation_id']))
            ->orderByDesc('allocations.created_at')->orderByDesc('allocations.id')
            ->offset(isset($data['allocation_id']) ? 0 : ($historyPage - 1) * 20)->limit(21)
            ->select(['allocations.id', 'allocations.fee_id', 'allocations.target_branch_id', 'target_branches.name as target_branch_name',
                'allocations.currency', 'allocations.actor_name',
                'allocations.created_at', 'fees.attempt_id', 'fees.created_at as fee_created_at',
                'reversals.id as reversal_id', 'reversals.reason as reversal_reason',
                'reversals.actor_name as reversed_by_name', 'reversals.created_at as reversed_at'])
            ->selectRaw('allocations.amount::text as amount')
            ->selectSub($this->originalFeeGroupName(), 'group_name');
        $payment = StudentPhotos::visibleStudent($studentId, $permissions, 'finance.read')
            ->join('student_payments as payments', 'payments.student_id', '=', 'students.id')
            ->join('branches as source_branches', 'source_branches.id', '=', 'payments.branch_id')
            ->where('payments.id', $paymentId)
            ->select(['payments.id', 'payments.branch_id', 'source_branches.name as branch_name', 'payments.amount', 'payments.currency',
                'students.financial_account_revision'])
            ->selectSub(ActiveStudentAllocations::query()->whereColumn('allocations.payment_id', 'payments.id')
                ->selectRaw('COALESCE(SUM(allocations.amount), 0)'), 'used_amount')
            ->selectSub(DB::connection('tenant')->query()->fromSub($historyQuery, 'history_rows')
                ->selectRaw("COALESCE(json_agg(history_rows ORDER BY created_at DESC, id DESC), '[]'::json)"), 'history_rows')->first();
        abort_unless($payment && $permissions->can('finance.read', (int) $payment->branch_id), 404);

        $history = collect(json_decode($payment->history_rows ?? '[]'));
        $eligibleBranches = $permissions->isCenterManager() ? null : array_values(array_filter(
            array_keys($permissions->branchRoles),
            fn (int|string $branchId): bool => (int) $branchId === (int) $payment->branch_id
                || $this->canAllocateToBranch($permissions, (int) $payment->branch_id, (int) $branchId),
        ));
        $fees = DB::connection('tenant')->table('study_attempt_fees as fees')
            ->join('branches as target_branches', 'target_branches.id', '=', 'fees.branch_id')
            ->where('fees.student_id', $studentId)
            ->when($eligibleBranches !== null, fn (Builder $query) => $query->whereIn('fees.branch_id', $eligibleBranches))
            ->orderByDesc('fees.created_at')->orderByDesc('fees.id')
            ->offset(($page - 1) * 20)->limit(21)
            ->select(['fees.id', 'fees.attempt_id', 'fees.branch_id', 'target_branches.name as branch_name', 'fees.net_amount', 'fees.currency',
                'fees.created_at as fee_created_at'])
            ->selectRaw(EffectiveStudyFees::amount('fees').' AS current_due')
            ->selectSub($this->originalFeeGroupName(), 'group_name')
            ->selectSub(ActiveStudentAllocations::query()->whereColumn('allocations.fee_id', 'fees.id')
                ->selectRaw('COALESCE(SUM(allocations.amount), 0)'), 'paid_amount')->get();

        return response()->json([
            'payment' => ['id' => $payment->id, 'branch_id' => (int) $payment->branch_id, 'branch_name' => $payment->branch_name,
                'amount' => $payment->amount, 'currency' => $payment->currency,
                'available_amount' => StudentMoney::format(StudentMoney::cents($payment->amount) - StudentMoney::cents($payment->used_amount))],
            'version' => StudentAccountVersion::forActor($studentId, $payment->financial_account_revision, $request->user()->id),
            'can_allocate' => $permissions->can('payments.allocate', (int) $payment->branch_id),
            'can_correct' => $permissions->can('payments.correct', (int) $payment->branch_id),
            'fees' => $fees->take(20)->map(fn (object $row) => [
                ...(array) $row,
                'paid_amount' => StudentMoney::format(StudentMoney::cents($row->paid_amount)),
                'remaining_amount' => StudentMoney::format(StudentMoney::cents($row->current_due) - StudentMoney::cents($row->paid_amount)),
            ])->values(),
            'history' => $history->take(20)->map(fn (object $row): array => [
                ...(array) $row,
                'can_correct' => $this->canCorrectAllocation($permissions, (int) $payment->branch_id,
                    (int) $row->target_branch_id),
            ])->values(),
            'pagination' => ['page' => $page, 'has_more' => $fees->count() > 20,
                'history_page' => $historyPage, 'history_has_more' => $history->count() > 20],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function preview(Request $request, string $studentId, string $paymentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($paymentId), 404);
        $data = $this->allocationData($request, false);
        $permissions = $request->attributes->get('center_permissions');
        $payment = $this->visiblePayment($studentId, $paymentId, $permissions);
        abort_unless($permissions->can('payments.allocate', (int) $payment->branch_id), 403);
        $student = StudentPhotos::visibleStudent($studentId, $permissions, 'payments.allocate')
            ->first(['students.id', 'students.financial_account_revision']);
        abort_unless($student, 404);
        if (! hash_equals(StudentAccountVersion::forActor($studentId, $student->financial_account_revision, $request->user()->id), $data['version'])) {
            $this->conflict('student_account_changed');
        }
        $plan = $this->allocationPlan($studentId, $payment, $data['targets'], $permissions);

        return response()->json([...$plan, 'version' => $data['version']])->header('Cache-Control', 'private, no-store');
    }

    public function allocate(Request $request, string $studentId, string $paymentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($paymentId), 404);
        $data = $this->allocationData($request, true);
        $targets = $data['targets'];
        $hash = hash('sha256', json_encode([$studentId, $paymentId, $targets]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $paymentId, $data, $targets, $hash): JsonResponse {
            $payment = $this->visiblePayment($studentId, $paymentId, $permissions);
            abort_unless($permissions->can('payments.allocate', (int) $payment->branch_id), 403);
            $student = StudentPhotos::visibleStudent($studentId, $permissions, 'payments.allocate')
                ->lockForUpdate()->first(['students.id', 'students.financial_account_revision']);
            abort_unless($student, 404);
            $existing = DB::connection('tenant')->table('student_allocation_submissions')->where('request_id', $data['request_id'])->first();
            if ($existing) {
                abort_unless($existing->student_id === $studentId && $existing->actor_id === $request->user()->id, 403);
                if ($existing->kind !== 'allocate' || $existing->request_hash !== $hash) {
                    $this->conflict('allocation_request_changed');
                }
                $saved = DB::connection('tenant')->table('student_payment_allocations')
                    ->whereIn('id', json_decode($existing->allocation_ids, true))->get();
                foreach ($saved as $allocation) {
                    abort_unless($this->canAllocateToBranch($permissions, (int) $payment->branch_id,
                        (int) $allocation->target_branch_id), 403);
                }

                return response()->json(['allocations' => $saved,
                    'version' => StudentAccountVersion::forActor($studentId, $student->financial_account_revision, $request->user()->id)]);
            }
            if (! hash_equals(StudentAccountVersion::forActor($studentId, $student->financial_account_revision, $request->user()->id), $data['version'])) {
                $this->conflict('student_account_changed');
            }
            $plan = $this->allocationPlan($studentId, $payment, $targets, $permissions);
            $ids = [];
            $rows = [];
            $auditAllocations = [];
            foreach ($plan['targets'] as $target) {
                $id = (string) Str::uuid();
                $ids[] = $id;
                $rows[] = ['id' => $id, 'student_id' => $studentId, 'payment_id' => $paymentId,
                    'fee_id' => $target['fee_id'], 'source_branch_id' => $payment->branch_id,
                    'target_branch_id' => $target['branch_id'], 'amount' => $target['amount'],
                    'currency' => $payment->currency, 'actor_id' => $request->user()->id,
                    'actor_name' => $request->user()->name, 'submission_id' => $data['request_id'], 'created_at' => now()];
                $auditAllocations[] = ['id' => $id, 'fee_id' => $target['fee_id'], 'attempt_id' => $target['attempt_id'],
                    'target_branch_id' => $target['branch_id'], 'target_branch_name' => $target['branch_name'],
                    'amount' => $target['amount'],
                    'fee_due_before' => $target['remaining_before'], 'fee_due_after' => $target['remaining_after']];
            }
            DB::connection('tenant')->table('student_allocation_submissions')->insert([
                'request_id' => $data['request_id'], 'student_id' => $studentId, 'kind' => 'allocate',
                'request_hash' => $hash, 'actor_id' => $request->user()->id,
                'allocation_ids' => json_encode($ids), 'created_at' => now(),
            ]);
            DB::connection('tenant')->table('student_payment_allocations')->insert($rows);
            DB::connection('tenant')->table('students')->where('id', $studentId)->update([
                'financial_account_revision' => $student->financial_account_revision + 1,
            ]);
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'branch_id' => $payment->branch_id,
                'event' => 'student.payment_allocated',
                'details' => json_encode(['student_id' => $studentId, 'payment_id' => $paymentId,
                    'branch_id' => $payment->branch_id, 'source_branch_name' => $payment->branch_name,
                    'allocations' => $auditAllocations,
                    'related_branch_ids' => array_values(array_unique(array_column($plan['targets'], 'branch_id'))),
                    'payment_available_before' => $plan['source']['available_before'],
                    'payment_available_after' => $plan['source']['available_after'],
                    'currency' => $payment->currency]),
                'created_at' => now(),
            ]);

            return response()->json(['allocations' => $rows,
                'version' => StudentAccountVersion::forActor($studentId, $student->financial_account_revision + 1, $request->user()->id)], 201)
                ->header('Cache-Control', 'private, no-store');
        });
    }

    public function reverse(Request $request, string $studentId, string $allocationId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($allocationId), 404);
        $data = $request->validate(['reason' => ['required', 'string', 'max:2000'],
            'version' => ['required', 'regex:/^[a-f0-9]{64}$/'], 'request_id' => ['required', 'uuid']]);
        $reason = trim($data['reason']);
        abort_unless($reason !== '', 422, 'أدخل سبب عكس التخصيص.');
        $hash = hash('sha256', json_encode([$studentId, $allocationId, $reason]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $allocationId, $data, $reason, $hash): JsonResponse {
            $allocation = DB::connection('tenant')->table('student_payment_allocations')
                ->where('id', $allocationId)->where('student_id', $studentId)->first();
            abort_unless($allocation && $permissions->can('payments.correct', (int) $allocation->source_branch_id)
                && $permissions->can('finance.read', (int) $allocation->target_branch_id), 404);
            abort_unless($this->canCorrectAllocation($permissions, (int) $allocation->source_branch_id,
                (int) $allocation->target_branch_id), 403);
            $student = StudentPhotos::visibleStudent($studentId, $permissions, 'payments.correct')
                ->lockForUpdate()->first(['students.id', 'students.financial_account_revision']);
            abort_unless($student, 404);
            $existing = DB::connection('tenant')->table('student_allocation_submissions')->where('request_id', $data['request_id'])->first();
            if ($existing) {
                abort_unless($existing->student_id === $studentId && $existing->actor_id === $request->user()->id, 403);
                if ($existing->kind !== 'reverse' || $existing->request_hash !== $hash) {
                    $this->conflict('allocation_request_changed');
                }

                return response()->json(['reversal' => DB::connection('tenant')->table('student_payment_allocation_reversals')
                    ->where('allocation_id', $allocationId)->firstOrFail(),
                    'version' => StudentAccountVersion::forActor($studentId, $student->financial_account_revision, $request->user()->id)]);
            }
            if (! hash_equals(StudentAccountVersion::forActor($studentId, $student->financial_account_revision, $request->user()->id), $data['version'])) {
                $this->conflict('student_account_changed');
            }
            if (DB::connection('tenant')->table('student_payment_allocation_reversals')->where('allocation_id', $allocationId)->exists()) {
                $this->conflict('allocation_already_reversed');
            }
            $availableBefore = StudentMoney::cents(DB::connection('tenant')->table('student_payments')
                ->where('id', $allocation->payment_id)->value('amount')) - $this->used($allocation->payment_id);
            $paidBefore = StudentMoney::cents(ActiveStudentAllocations::query()->where('allocations.fee_id', $allocation->fee_id)
                ->sum('allocations.amount'));
            $amount = StudentMoney::cents($allocation->amount);
            $reversal = ['id' => (string) Str::uuid(), 'allocation_id' => $allocationId,
                'student_id' => $studentId, 'reason' => $reason, 'actor_id' => $request->user()->id,
                'actor_name' => $request->user()->name, 'submission_id' => $data['request_id'], 'created_at' => now()];
            DB::connection('tenant')->table('student_allocation_submissions')->insert([
                'request_id' => $data['request_id'], 'student_id' => $studentId, 'kind' => 'reverse',
                'request_hash' => $hash, 'actor_id' => $request->user()->id,
                'allocation_ids' => json_encode([$allocationId]), 'created_at' => now(),
            ]);
            DB::connection('tenant')->table('student_payment_allocation_reversals')->insert($reversal);
            DB::connection('tenant')->table('students')->where('id', $studentId)->update([
                'financial_account_revision' => $student->financial_account_revision + 1,
            ]);
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'branch_id' => $allocation->source_branch_id,
                'event' => 'student.payment_allocation_reversed',
                'details' => json_encode(['student_id' => $studentId, 'allocation_id' => $allocationId,
                    'payment_id' => $allocation->payment_id, 'fee_id' => $allocation->fee_id,
                    'related_branch_ids' => [(int) $allocation->target_branch_id],
                    'amount' => $allocation->amount, 'reason' => $reason,
                    'payment_available_before' => StudentMoney::format($availableBefore),
                    'payment_available_after' => StudentMoney::format($availableBefore + $amount),
                    'fee_paid_before' => StudentMoney::format($paidBefore),
                    'fee_paid_after' => StudentMoney::format($paidBefore - $amount)]), 'created_at' => now(),
            ]);

            return response()->json(['reversal' => $reversal,
                'version' => StudentAccountVersion::forActor($studentId, $student->financial_account_revision + 1, $request->user()->id)], 201)
                ->header('Cache-Control', 'private, no-store');
        });
    }

    private function visiblePayment(string $studentId, string $paymentId, CenterPermissions $permissions): object
    {
        $payment = DB::connection('tenant')->table('student_payments as payments')
            ->join('branches as source_branches', 'source_branches.id', '=', 'payments.branch_id')
            ->where('payments.id', $paymentId)->where('payments.student_id', $studentId)
            ->select(['payments.*', 'source_branches.name as branch_name'])->first();
        abort_unless($payment && $permissions->can('finance.read', (int) $payment->branch_id), 404);

        return $payment;
    }

    private function allocationData(Request $request, bool $withRequestId): array
    {
        $data = $request->validate([
            'targets' => ['required', 'array', 'min:1', 'max:20'],
            'targets.*.attempt_id' => ['required', 'uuid', 'distinct'],
            'targets.*.amount' => ['required', 'numeric', 'decimal:0,2', 'gt:0', 'max:9999999999.99', 'regex:/^\d{1,10}(?:\.\d{1,2})?$/'],
            'version' => ['required', 'regex:/^[a-f0-9]{64}$/'],
            ...($withRequestId ? ['request_id' => ['required', 'uuid']] : []),
        ]);
        $data['targets'] = array_map(fn (array $target): array => ['attempt_id' => $target['attempt_id'],
            'amount' => StudentMoney::format(StudentMoney::cents($target['amount']))], $data['targets']);

        return $data;
    }

    private function canAllocateToBranch(CenterPermissions $permissions, int $sourceBranchId, int $targetBranchId): bool
    {
        if (! $permissions->can('payments.allocate', $sourceBranchId)) {
            return false;
        }
        if ($sourceBranchId === $targetBranchId) {
            return true;
        }

        return $permissions->can('finance.read', $sourceBranchId)
            && $permissions->can('finance.read', $targetBranchId)
            && $permissions->can('payments.allocate', $targetBranchId)
            && $permissions->can('finance.approve', $sourceBranchId)
            && $permissions->can('finance.approve', $targetBranchId);
    }

    private function canCorrectAllocation(CenterPermissions $permissions, int $sourceBranchId, int $targetBranchId): bool
    {
        if (! $permissions->can('payments.correct', $sourceBranchId)) {
            return false;
        }
        if ($sourceBranchId === $targetBranchId) {
            return true;
        }

        return $permissions->can('finance.read', $targetBranchId)
            && $permissions->can('payments.correct', $targetBranchId)
            && $permissions->can('finance.approve', $sourceBranchId)
            && $permissions->can('finance.approve', $targetBranchId);
    }

    private function allocationPlan(string $studentId, object $payment, array $targets, CenterPermissions $permissions): array
    {
        $sum = array_sum(array_map(fn (array $target): int => StudentMoney::cents($target['amount']), $targets));
        $availableBefore = StudentMoney::cents($payment->amount) - $this->used($payment->id);
        if ($sum > $availableBefore) {
            $this->conflict('payment_not_available');
        }
        $fees = DB::connection('tenant')->table('study_attempt_fees as fees')
            ->join('branches as target_branches', 'target_branches.id', '=', 'fees.branch_id')
            ->where('fees.student_id', $studentId)->whereIn('fees.attempt_id', array_column($targets, 'attempt_id'))
            ->select(['fees.id', 'fees.attempt_id', 'fees.branch_id', 'target_branches.name as branch_name', 'fees.currency'])
            ->selectRaw(EffectiveStudyFees::amount('fees').' AS current_due')
            ->selectSub($this->originalFeeGroupName(), 'group_name')
            ->selectSub(ActiveStudentAllocations::query()->whereColumn('allocations.fee_id', 'fees.id')
                ->selectRaw('COALESCE(SUM(allocations.amount), 0)'), 'paid_amount')
            ->get()->keyBy('attempt_id');
        abort_unless($fees->count() === count($targets), 404);
        $planned = [];
        foreach ($targets as $target) {
            $fee = $fees->get($target['attempt_id']);
            abort_unless($fee && $permissions->can('finance.read', (int) $fee->branch_id), 404);
            abort_unless($this->canAllocateToBranch($permissions, (int) $payment->branch_id, (int) $fee->branch_id), 403);
            abort_unless($fee->currency === $payment->currency, 422, 'عملة الرسوم لا تطابق الدفعة.');
            $amount = StudentMoney::cents($target['amount']);
            $remaining = StudentMoney::cents($fee->current_due) - StudentMoney::cents($fee->paid_amount);
            if ($amount > $remaining) {
                $this->conflict('fee_already_paid');
            }
            $planned[] = ['attempt_id' => $target['attempt_id'], 'fee_id' => $fee->id,
                'branch_id' => (int) $fee->branch_id, 'branch_name' => $fee->branch_name,
                'group_name' => $fee->group_name,
                'amount' => $target['amount'], 'remaining_before' => StudentMoney::format($remaining),
                'remaining_after' => StudentMoney::format($remaining - $amount)];
        }

        return [
            'source' => ['payment_id' => $payment->id, 'branch_id' => (int) $payment->branch_id,
                'branch_name' => $payment->branch_name, 'currency' => $payment->currency,
                'available_before' => StudentMoney::format($availableBefore),
                'available_after' => StudentMoney::format($availableBefore - $sum)],
            'targets' => $planned,
            'cross_branch' => collect($planned)->contains(fn (array $target): bool => $target['branch_id'] !== (int) $payment->branch_id),
        ];
    }

    private function originalFeeGroupName(): Builder
    {
        return DB::connection('tenant')->table('study_attempt_group_periods as original_periods')
            ->join('study_groups as original_groups', 'original_groups.id', '=', 'original_periods.group_id')
            ->join('levels as original_levels', 'original_levels.id', '=', 'original_groups.level_id')
            ->join('stages as original_stages', 'original_stages.id', '=', 'original_levels.stage_id')
            ->join('courses as original_courses', 'original_courses.id', '=', 'original_stages.course_id')
            ->whereColumn('original_periods.attempt_id', 'fees.attempt_id')
            ->whereColumn('original_courses.branch_id', 'fees.branch_id')
            ->orderBy('original_periods.created_at')->orderBy('original_periods.id')
            ->limit(1)->select('original_groups.name');
    }

    private function used(string $paymentId): int
    {
        return StudentMoney::cents(ActiveStudentAllocations::query()->where('allocations.payment_id', $paymentId)
            ->sum('allocations.amount'));
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
