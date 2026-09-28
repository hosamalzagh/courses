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
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudentFeeAdjustmentController extends Controller
{
    public function show(Request $request, string $studentId, string $feeId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($feeId), 404);
        $data = $request->validate([
            'new_due' => ['sometimes', 'numeric', 'decimal:0,2', 'min:0', 'max:9999999999.99', 'regex:/^\d{1,10}(?:\.\d{1,2})?$/'],
            'replaces_adjustment_id' => ['sometimes', 'nullable', 'uuid'],
            'history_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        $historyPage = (int) ($data['history_page'] ?? 1);
        $fee = $this->visibleFee($studentId, $feeId, $permissions, $historyPage);
        $history = collect(json_decode($fee->history_rows ?? '[]', true));
        $account = $this->account($studentId, $permissions);
        $preview = null;
        if (array_key_exists('new_due', $data)) {
            abort_unless($permissions->can('finance.approve', (int) $fee->branch_id), 403);
            $replacement = $this->replacement($feeId, $data['replaces_adjustment_id'] ?? null);
            $target = StudentMoney::cents($data['new_due']);
            abort_if($replacement === null && $target === StudentMoney::cents($fee->current_due), 422,
                'أدخل مستحقًا مختلفًا لاعتماد تسوية جديدة.');
            $allocations = $this->allocations($feeId);
            [$release, $released] = $this->releasePlan($allocations, StudentMoney::cents($fee->paid_amount), $target);
            $this->authorizeRelease($permissions, $release);
            $preview = $this->preview($fee, $account, $target, $released, $release, $replacement);
        }

        return response()->json([
            'fee' => $this->presentFee($fee),
            'version' => StudentAccountVersion::forActor($studentId, $fee->financial_account_revision, $request->user()->id),
            'can_approve' => $permissions->can('finance.approve', (int) $fee->branch_id),
            'account' => $this->presentAccount($account),
            'latest_active_adjustment_id' => $fee->latest_active_adjustment_id,
            'history' => $history->take(20)->values(),
            'pagination' => ['history_page' => $historyPage, 'history_has_more' => $history->count() > 20],
            'preview' => $preview,
        ])->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request, string $studentId, string $feeId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($feeId), 404);
        $data = $request->validate([
            'new_due' => ['required', 'numeric', 'decimal:0,2', 'min:0', 'max:9999999999.99', 'regex:/^\d{1,10}(?:\.\d{1,2})?$/'],
            'reason' => ['required', 'string', 'max:2000'],
            'replaces_adjustment_id' => ['present', 'nullable', 'uuid'],
            'version' => ['required', 'regex:/^[a-f0-9]{64}$/'],
            'request_id' => ['required', 'uuid'],
        ]);
        $reason = trim($data['reason']);
        abort_unless($reason !== '', 422, 'أدخل سبب التسوية أو التصحيح.');
        $target = StudentMoney::cents($data['new_due']);
        $kind = $data['replaces_adjustment_id'] === null ? 'settle' : 'correct';
        $hash = hash('sha256', json_encode([$studentId, $feeId, $kind, $target, $reason, $data['replaces_adjustment_id']]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $feeId, $data, $reason, $target, $kind, $hash): JsonResponse {
            $student = StudentPhotos::visibleStudent($studentId, $permissions, 'finance.read')
                ->lockForUpdate()->first(['students.id', 'students.financial_account_revision']);
            abort_unless($student, 404);
            $fee = $this->visibleFee($studentId, $feeId, $permissions);
            $existing = DB::connection('tenant')->table('study_fee_adjustment_submissions')
                ->where('request_id', $data['request_id'])->first();
            if ($existing !== null) {
                abort_unless($existing->student_id === $studentId && $existing->fee_id === $feeId
                    && $existing->actor_id === $request->user()->id, 403);
                if ($existing->kind !== $kind || $existing->request_hash !== $hash) {
                    $this->conflict('fee_adjustment_request_changed');
                }

                return response()->json(['adjustments' => DB::connection('tenant')->table('study_fee_adjustments')
                    ->where('submission_id', $data['request_id'])->orderBy('sequence')->get(),
                    'version' => StudentAccountVersion::forActor($studentId, $student->financial_account_revision, $request->user()->id)]);
            }
            abort_unless($permissions->can('finance.approve', (int) $fee->branch_id), 403);
            if (! hash_equals(StudentAccountVersion::forActor($studentId, $student->financial_account_revision, $request->user()->id), $data['version'])) {
                $this->conflict('student_account_changed');
            }
            $replacement = $this->replacement($feeId, $data['replaces_adjustment_id']);
            $before = StudentMoney::cents($fee->current_due);
            abort_if($replacement === null && $target === $before, 422, 'أدخل مستحقًا مختلفًا لاعتماد تسوية جديدة.');
            $afterReversal = $replacement === null ? $before : $before - $this->signedCents($replacement->amount_delta);
            abort_if($afterReversal < 0, 409, 'تغيرت حركات الرسوم؛ حمّل أحدث البيانات.');
            $allocations = $this->allocations($feeId);
            [$release, $released] = $this->releasePlan($allocations, StudentMoney::cents($fee->paid_amount), $target);
            $this->authorizeRelease($permissions, $release);
            $account = $this->account($studentId, $permissions);
            $preview = $this->preview($fee, $account, $target, $released, $release, $replacement);
            $now = now();
            DB::connection('tenant')->table('study_fee_adjustment_submissions')->insert([
                'request_id' => $data['request_id'], 'student_id' => $studentId, 'fee_id' => $feeId,
                'kind' => $kind, 'request_hash' => $hash, 'actor_id' => $request->user()->id,
                'created_at' => $now,
            ]);
            $rows = [];
            if ($replacement !== null) {
                $rows[] = $this->adjustmentRow($data['request_id'], 1, $studentId, $fee, 'reversal',
                    $before, $afterReversal, $reason, $request, $now, $replacement->id, null);
            }
            $rows[] = $this->adjustmentRow($data['request_id'], $replacement === null ? 1 : 2,
                $studentId, $fee, 'settlement', $afterReversal, $target, $reason, $request, $now,
                null, $replacement?->id);
            DB::connection('tenant')->table('study_fee_adjustments')->insert($rows);
            $this->releaseAllocations($studentId, $fee, $release, $reason, $request, $now);
            DB::connection('tenant')->table('students')->where('id', $studentId)->update([
                'financial_account_revision' => $student->financial_account_revision + 1,
            ]);
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'branch_id' => $fee->branch_id,
                'event' => $replacement === null ? 'student.fee_settled' : 'student.fee_settlement_corrected',
                'details' => json_encode(['student_id' => $studentId, 'fee_id' => $feeId,
                    'attempt_id' => $fee->attempt_id, 'reason' => $reason,
                    'replaces_adjustment_id' => $replacement?->id,
                    'adjustment_ids' => array_column($rows, 'id'),
                    'before_due' => $preview['fee_before'], 'after_due' => $preview['fee_after'],
                    'account_before' => $preview['account_before'], 'account_after' => $preview['account_after'],
                    'released_allocations' => $preview['released_allocations'], 'currency' => $fee->currency]),
                'created_at' => $now,
            ]);

            return response()->json(['adjustments' => $rows, 'preview' => $preview,
                'version' => StudentAccountVersion::forActor($studentId, $student->financial_account_revision + 1, $request->user()->id)], 201)
                ->header('Cache-Control', 'private, no-store');
        });
    }

    private function visibleFee(string $studentId, string $feeId, CenterPermissions $permissions, ?int $historyPage = null): object
    {
        $query = StudentPhotos::visibleStudent($studentId, $permissions, 'finance.read')
            ->join('study_attempt_fees as fees', 'fees.student_id', '=', 'students.id')
            ->join('study_attempts as attempts', 'attempts.id', '=', 'fees.attempt_id')
            ->leftJoin('study_attempt_withdrawals as withdrawals', 'withdrawals.attempt_id', '=', 'attempts.id')
            ->where('fees.id', $feeId)
            ->select(['fees.id', 'fees.attempt_id', 'fees.branch_id', 'fees.net_amount', 'fees.currency',
                'attempts.status', 'withdrawals.withdrawn_on', 'students.financial_account_revision'])
            ->selectRaw(EffectiveStudyFees::amount('fees').' AS current_due')
            ->selectSub(ActiveStudentAllocations::query()->whereColumn('allocations.fee_id', 'fees.id')
                ->selectRaw('COALESCE(SUM(allocations.amount), 0)'), 'paid_amount');
        if ($historyPage !== null) {
            $query->selectSub(DB::connection('tenant')->query()->fromSub($this->historyQuery($historyPage), 'history_rows')
                ->selectRaw("COALESCE(json_agg(history_rows), '[]'::json)"), 'history_rows');
            $query->selectSub(DB::connection('tenant')->table('study_fee_adjustments as latest_adjustment')
                ->whereColumn('latest_adjustment.fee_id', 'fees.id')->where('latest_adjustment.kind', 'settlement')
                ->whereNotExists(DB::connection('tenant')->table('study_fee_adjustments as latest_reversal')
                    ->whereColumn('latest_reversal.reverses_id', 'latest_adjustment.id')->selectRaw('1'))
                ->orderByDesc('latest_adjustment.created_at')->orderByDesc('latest_adjustment.sequence')
                ->select('latest_adjustment.id')->limit(1), 'latest_active_adjustment_id');
        }
        $fee = $query->first();
        abort_unless($fee && $permissions->can('finance.read', (int) $fee->branch_id), 404);

        return $fee;
    }

    private function historyQuery(int $page): Builder
    {
        return DB::connection('tenant')->table('study_fee_adjustments as adjustments')
            ->leftJoin('study_fee_adjustments as reversal', 'reversal.reverses_id', '=', 'adjustments.id')
            ->whereColumn('adjustments.fee_id', 'fees.id')
            ->orderByDesc('adjustments.created_at')->orderByDesc('adjustments.sequence')
            ->offset(($page - 1) * 20)->limit(21)
            ->select(['adjustments.id', 'adjustments.kind', 'adjustments.reverses_id',
                'adjustments.replaces_id', 'adjustments.reason', 'adjustments.actor_name',
                'adjustments.created_at', 'reversal.id as reversal_id'])
            ->selectRaw('adjustments.amount_delta::text AS amount_delta, adjustments.before_due::text AS before_due, adjustments.after_due::text AS after_due');
    }

    private function replacement(string $feeId, ?string $adjustmentId): ?object
    {
        if ($adjustmentId === null) {
            return null;
        }
        $latest = DB::connection('tenant')->table('study_fee_adjustments as adjustments')
            ->where('adjustments.fee_id', $feeId)->where('adjustments.kind', 'settlement')
            ->whereNotExists(DB::connection('tenant')->table('study_fee_adjustments as reversal')
                ->whereColumn('reversal.reverses_id', 'adjustments.id')->selectRaw('1'))
            ->orderByDesc('adjustments.created_at')->orderByDesc('adjustments.sequence')
            ->first(['adjustments.id', 'adjustments.amount_delta']);
        abort_unless($latest && $latest->id === $adjustmentId, 409,
            'يمكن تصحيح أحدث تسوية سارية فقط. حمّل تاريخ الرسوم الحالي.');

        return $latest;
    }

    private function allocations(string $feeId): Collection
    {
        return ActiveStudentAllocations::query()->where('allocations.fee_id', $feeId)
            ->orderByDesc('allocations.created_at')->orderByDesc('allocations.id')
            ->get(['allocations.id', 'allocations.payment_id', 'allocations.fee_id',
                'allocations.student_id', 'allocations.source_branch_id', 'allocations.target_branch_id',
                'allocations.amount', 'allocations.currency']);
    }

    private function releasePlan(Collection $allocations, int $paid, int $target): array
    {
        $excess = max(0, $paid - $target);
        $plan = [];
        foreach ($allocations as $allocation) {
            if ($excess === 0) {
                break;
            }
            $amount = StudentMoney::cents($allocation->amount);
            $released = min($amount, $excess);
            $plan[] = ['allocation' => $allocation, 'released' => $released, 'replacement' => $amount - $released];
            $excess -= $released;
        }
        abort_if($excess !== 0, 409, 'تغيرت تخصيصات الرسوم؛ حمّل أحدث البيانات.');

        return [$plan, max(0, $paid - $target)];
    }

    private function authorizeRelease(CenterPermissions $permissions, array $release): void
    {
        foreach ($release as $entry) {
            $allocation = $entry['allocation'];
            abort_unless($permissions->can('payments.correct', (int) $allocation->source_branch_id)
                && $permissions->can('finance.read', (int) $allocation->source_branch_id)
                && $permissions->can('finance.approve', (int) $allocation->source_branch_id)
                && $permissions->can('finance.approve', (int) $allocation->target_branch_id), 403);
        }
    }

    private function account(string $studentId, CenterPermissions $permissions): object
    {
        $scope = array_keys(array_filter($permissions->branchRoles,
            fn (array $roles): bool => in_array('finance.read', CenterPermissions::actions($roles), true)));
        $payments = DB::connection('tenant')->table('student_payments')
            ->whereColumn('student_payments.student_id', 'students.id')
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('student_payments.branch_id', $scope))
            ->selectRaw('COALESCE(SUM(student_payments.amount), 0)');
        $fees = DB::connection('tenant')->table('study_attempt_fees')
            ->whereColumn('study_attempt_fees.student_id', 'students.id')
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('study_attempt_fees.branch_id', $scope))
            ->selectRaw('COALESCE(SUM('.EffectiveStudyFees::amount('study_attempt_fees').'), 0)');
        $used = ActiveStudentAllocations::query()->whereColumn('allocations.student_id', 'students.id')
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('allocations.source_branch_id', $scope))
            ->selectRaw('COALESCE(SUM(allocations.amount), 0)');
        $paid = ActiveStudentAllocations::query()->whereColumn('allocations.student_id', 'students.id')
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('allocations.target_branch_id', $scope))
            ->selectRaw('COALESCE(SUM(allocations.amount), 0)');

        return DB::connection('tenant')->table('students')->where('students.id', $studentId)
            ->selectSub($payments, 'received')->selectSub($fees, 'due')
            ->selectSub($used, 'allocated')->selectSub($paid, 'paid')->firstOrFail();
    }

    private function preview(object $fee, object $account, int $target, int $released, array $release, ?object $replacement): array
    {
        $dueBefore = StudentMoney::cents($account->due);
        $paidBefore = StudentMoney::cents($account->paid);
        $received = StudentMoney::cents($account->received);
        $allocatedBefore = StudentMoney::cents($account->allocated);
        $dueAfter = $dueBefore + $target - StudentMoney::cents($fee->current_due);
        $paidAfter = $paidBefore - $released;
        $allocatedAfter = $allocatedBefore - $released;

        return [
            'fee_before' => $fee->current_due, 'fee_after' => StudentMoney::format($target),
            'fee_paid_before' => StudentMoney::format(StudentMoney::cents($fee->paid_amount)),
            'fee_paid_after' => StudentMoney::format(StudentMoney::cents($fee->paid_amount) - $released),
            'replaces_adjustment_id' => $replacement?->id,
            'account_before' => $this->presentAccount($account),
            'account_after' => ['received_total' => StudentMoney::format($received),
                'due_total' => StudentMoney::format($dueAfter), 'paid_total' => StudentMoney::format($paidAfter),
                'allocated_total' => StudentMoney::format($allocatedAfter),
                'available_balance' => StudentMoney::format($received - $allocatedAfter),
                'debt' => StudentMoney::format($dueAfter - $paidAfter)],
            'released_allocations' => array_map(fn (array $entry): array => [
                'allocation_id' => $entry['allocation']->id,
                'payment_id' => $entry['allocation']->payment_id,
                'released_amount' => StudentMoney::format($entry['released']),
                'replacement_amount' => StudentMoney::format($entry['replacement']),
            ], $release),
        ];
    }

    private function presentAccount(object $account): array
    {
        $received = StudentMoney::cents($account->received);
        $due = StudentMoney::cents($account->due);
        $paid = StudentMoney::cents($account->paid);
        $allocated = StudentMoney::cents($account->allocated);

        return ['received_total' => StudentMoney::format($received), 'due_total' => StudentMoney::format($due),
            'paid_total' => StudentMoney::format($paid), 'allocated_total' => StudentMoney::format($allocated),
            'available_balance' => StudentMoney::format($received - $allocated),
            'debt' => StudentMoney::format($due - $paid)];
    }

    private function presentFee(object $fee): array
    {
        return ['id' => $fee->id, 'attempt_id' => $fee->attempt_id, 'branch_id' => (int) $fee->branch_id,
            'status' => $fee->status, 'withdrawn_on' => $fee->withdrawn_on,
            'net_amount' => $fee->net_amount, 'current_due' => $fee->current_due,
            'paid_amount' => StudentMoney::format(StudentMoney::cents($fee->paid_amount)),
            'currency' => $fee->currency];
    }

    private function adjustmentRow(string $submissionId, int $sequence, string $studentId, object $fee,
        string $kind, int $before, int $after, string $reason, Request $request, mixed $now,
        ?string $reversesId, ?string $replacesId): array
    {
        return ['id' => (string) Str::uuid(), 'submission_id' => $submissionId, 'sequence' => $sequence,
            'student_id' => $studentId, 'fee_id' => $fee->id, 'branch_id' => $fee->branch_id,
            'kind' => $kind, 'amount_delta' => $this->formatSigned($after - $before),
            'before_due' => StudentMoney::format($before), 'after_due' => StudentMoney::format($after),
            'reverses_id' => $reversesId, 'replaces_id' => $replacesId, 'reason' => $reason,
            'actor_id' => $request->user()->id, 'actor_name' => $request->user()->name, 'created_at' => $now];
    }

    private function releaseAllocations(string $studentId, object $fee, array $release, string $reason, Request $request, mixed $now): void
    {
        if ($release === []) {
            return;
        }
        $reversalSubmissionId = (string) Str::uuid();
        $reversedIds = array_map(fn (array $entry): string => $entry['allocation']->id, $release);
        DB::connection('tenant')->table('student_allocation_submissions')->insert([
            'request_id' => $reversalSubmissionId, 'student_id' => $studentId, 'kind' => 'reverse',
            'request_hash' => hash('sha256', json_encode([$fee->id, $reversedIds, $reason])),
            'actor_id' => $request->user()->id, 'allocation_ids' => json_encode($reversedIds), 'created_at' => $now,
        ]);
        $reversals = [];
        $replacementRows = [];
        foreach ($release as $entry) {
            $allocation = $entry['allocation'];
            $reversals[] = ['id' => (string) Str::uuid(), 'allocation_id' => $allocation->id,
                'student_id' => $studentId, 'reason' => 'تسوية الرسوم: '.$reason,
                'actor_id' => $request->user()->id, 'actor_name' => $request->user()->name,
                'submission_id' => $reversalSubmissionId, 'created_at' => $now];
            if ($entry['replacement'] > 0) {
                $replacementRows[] = ['id' => (string) Str::uuid(), 'student_id' => $studentId,
                    'payment_id' => $allocation->payment_id, 'fee_id' => $fee->id,
                    'source_branch_id' => $allocation->source_branch_id,
                    'target_branch_id' => $allocation->target_branch_id,
                    'amount' => StudentMoney::format($entry['replacement']), 'currency' => $allocation->currency,
                    'actor_id' => $request->user()->id, 'actor_name' => $request->user()->name,
                    'created_at' => $now];
            }
        }
        DB::connection('tenant')->table('student_payment_allocation_reversals')->insert($reversals);
        if ($replacementRows !== []) {
            $allocationSubmissionId = (string) Str::uuid();
            DB::connection('tenant')->table('student_allocation_submissions')->insert([
                'request_id' => $allocationSubmissionId, 'student_id' => $studentId, 'kind' => 'allocate',
                'request_hash' => hash('sha256', json_encode([$fee->id, $reversedIds, $replacementRows])),
                'actor_id' => $request->user()->id,
                'allocation_ids' => json_encode(array_column($replacementRows, 'id')), 'created_at' => $now,
            ]);
            foreach ($replacementRows as &$row) {
                $row['submission_id'] = $allocationSubmissionId;
            }
            unset($row);
            DB::connection('tenant')->table('student_payment_allocations')->insert($replacementRows);
        }
    }

    private function signedCents(string $amount): int
    {
        return str_starts_with($amount, '-') ? -StudentMoney::cents(substr($amount, 1)) : StudentMoney::cents($amount);
    }

    private function formatSigned(int $cents): string
    {
        return $cents < 0 ? '-'.StudentMoney::format(-$cents) : StudentMoney::format($cents);
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
