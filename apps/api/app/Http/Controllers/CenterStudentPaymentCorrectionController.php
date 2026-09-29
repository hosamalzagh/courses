<?php

namespace App\Http\Controllers;

use App\Support\ActiveStudentAllocations;
use App\Support\ActiveStudentRefunds;
use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\EffectiveStudentPayments;
use App\Support\EffectiveStudyFees;
use App\Support\StudentAccountVersion;
use App\Support\StudentMoney;
use App\Support\StudentPhotos;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudentPaymentCorrectionController extends Controller
{
    public function index(Request $request, string $studentId, string $paymentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($paymentId), 404);
        $data = $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'history_page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $permissions = $request->attributes->get('center_permissions');
        $page = (int) ($data['page'] ?? 1);
        $historyPage = (int) ($data['history_page'] ?? 1);
        $payment = $this->payment($studentId, $paymentId, $permissions, $page, $historyPage);
        $affectedBranches = array_map('intval', json_decode($payment->affected_branches, true));
        foreach ($affectedBranches as $branchId) {
            abort_unless($permissions->can('finance.read', $branchId), 404);
        }
        $allocations = collect(json_decode($payment->allocation_rows, true));
        $history = collect(json_decode($payment->history_rows, true));

        return response()->json([
            'payment' => $this->balance($payment), 'original_amount' => $payment->original_amount,
            'version' => StudentAccountVersion::forActor($studentId, $payment->financial_account_revision, $request->user()->id),
            'can_correct' => $this->canCorrect($permissions, (int) $payment->branch_id)
                && collect($affectedBranches)->every(fn (int $branchId): bool => $this->canCorrectAllocation(
                    $permissions, (int) $payment->branch_id, $branchId)),
            'allocations' => $allocations->take(20), 'history' => $history->take(20),
            'pagination' => ['page' => $page, 'has_more' => $allocations->count() > 20,
                'history_page' => $historyPage, 'history_has_more' => $history->count() > 20],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function preview(Request $request, string $studentId, string $paymentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($paymentId), 404);
        $data = $this->data($request, false);
        $permissions = $request->attributes->get('center_permissions');
        $payment = $this->payment($studentId, $paymentId, $permissions);
        abort_unless($this->canCorrect($permissions, (int) $payment->branch_id), 403);
        $affectedBranches = $this->checkAffectedBranches($paymentId, $payment->branch_id, $permissions);
        $this->checkVersion($studentId, $payment->financial_account_revision, $request, $data['version']);

        return response()->json([...$this->plan($studentId, $payment, $data, $permissions, $affectedBranches),
            'version' => $data['version']])->header('Cache-Control', 'private, no-store');
    }

    public function correct(Request $request, string $studentId, string $paymentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($paymentId), 404);
        $data = $this->data($request, true);
        $hash = hash('sha256', json_encode([$studentId, $paymentId, $data['correct_amount'], $data['allocations'], $data['reason']]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $paymentId, $data, $hash): JsonResponse {
            $payment = $this->payment($studentId, $paymentId, $permissions);
            abort_unless($this->canCorrect($permissions, (int) $payment->branch_id), 403);
            $affectedBranches = $this->checkAffectedBranches($paymentId, $payment->branch_id, $permissions);
            $student = StudentPhotos::visibleStudent($studentId, $permissions, 'payments.correct')
                ->lockForUpdate()->first(['students.id', 'students.financial_account_revision']);
            abort_unless($student, 404);
            $existing = DB::connection('tenant')->table('student_payment_correction_submissions')
                ->where('request_id', $data['request_id'])->first();
            if ($existing) {
                abort_unless($existing->student_id === $studentId && $existing->payment_id === $paymentId
                    && $existing->actor_id === $request->user()->id, 403);
                if ($existing->request_hash !== $hash) {
                    $this->conflict('payment_correction_request_changed');
                }

                return response()->json([
                    'reversal' => DB::connection('tenant')->table('student_payment_reversals')
                        ->where('submission_id', $data['request_id'])->firstOrFail(),
                    'replacement' => DB::connection('tenant')->table('student_payment_replacements')
                        ->where('submission_id', $data['request_id'])->firstOrFail(),
                    'version' => StudentAccountVersion::forActor($studentId, $student->financial_account_revision, $request->user()->id),
                ])->header('Cache-Control', 'private, no-store');
            }
            $this->checkVersion($studentId, $student->financial_account_revision, $request, $data['version']);
            $plan = $this->plan($studentId, $payment, $data, $permissions, $affectedBranches);
            $now = now();
            $prior = DB::connection('tenant')->table('student_payment_replacements as replacements')
                ->where('replacements.payment_id', $paymentId)
                ->whereNotExists(DB::connection('tenant')->table('student_payment_reversals as next_reversals')
                    ->whereColumn('next_reversals.prior_replacement_id', 'replacements.id')->selectRaw('1'))
                ->value('replacements.id');
            $reversal = ['id' => (string) Str::uuid(), 'payment_id' => $paymentId,
                'prior_replacement_id' => $prior, 'reason' => $data['reason'],
                'actor_id' => $request->user()->id, 'actor_name' => $request->user()->name,
                'submission_id' => $data['request_id'], 'created_at' => $now];
            $replacement = ['id' => (string) Str::uuid(), 'payment_id' => $paymentId,
                'reversal_id' => $reversal['id'], 'amount' => $data['correct_amount'],
                'actor_id' => $request->user()->id, 'actor_name' => $request->user()->name,
                'submission_id' => $data['request_id'], 'created_at' => $now];
            DB::connection('tenant')->table('student_payment_correction_submissions')->insert([
                'request_id' => $data['request_id'], 'student_id' => $studentId, 'payment_id' => $paymentId,
                'request_hash' => $hash, 'actor_id' => $request->user()->id, 'created_at' => $now,
            ]);
            DB::connection('tenant')->table('student_payment_reversals')->insert($reversal);
            DB::connection('tenant')->table('student_payment_replacements')->insert($replacement);
            $links = [];
            foreach ($plan['allocations'] as $change) {
                $submissionId = (string) Str::uuid();
                $reversedId = (string) Str::uuid();
                $newId = StudentMoney::cents($change['amount_after']) ? (string) Str::uuid() : null;
                DB::connection('tenant')->table('student_allocation_submissions')->insert([
                    'request_id' => $submissionId, 'student_id' => $studentId, 'kind' => 'payment_correct',
                    'request_hash' => $hash, 'actor_id' => $request->user()->id,
                    'allocation_ids' => json_encode(array_values(array_filter([$change['id'], $newId]))), 'created_at' => $now,
                ]);
                DB::connection('tenant')->table('student_payment_allocation_reversals')->insert([
                    'id' => $reversedId, 'allocation_id' => $change['id'], 'student_id' => $studentId,
                    'reason' => $data['reason'], 'actor_id' => $request->user()->id,
                    'actor_name' => $request->user()->name, 'submission_id' => $submissionId, 'created_at' => $now,
                ]);
                if ($newId) {
                    DB::connection('tenant')->table('student_payment_allocations')->insert([
                        'id' => $newId, 'student_id' => $studentId, 'payment_id' => $paymentId,
                        'fee_id' => $change['fee_id'], 'source_branch_id' => $payment->branch_id,
                        'target_branch_id' => $change['target_branch_id'], 'amount' => $change['amount_after'],
                        'currency' => $payment->currency, 'actor_id' => $request->user()->id,
                        'actor_name' => $request->user()->name, 'submission_id' => $submissionId, 'created_at' => $now,
                    ]);
                }
                $links[] = ['payment_reversal_id' => $reversal['id'], 'original_allocation_id' => $change['id'],
                    'allocation_reversal_id' => $reversedId, 'replacement_allocation_id' => $newId,
                    'amount_before' => $change['amount_before'], 'amount_after' => $change['amount_after'], 'created_at' => $now];
            }
            if ($links) {
                DB::connection('tenant')->table('student_payment_correction_allocations')->insert($links);
            }
            DB::connection('tenant')->table('students')->where('id', $studentId)->update([
                'financial_account_revision' => $student->financial_account_revision + 1,
            ]);
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'branch_id' => $payment->branch_id,
                'event' => 'student.payment_corrected', 'details' => json_encode([
                    'student_id' => $studentId, 'payment_id' => $paymentId,
                    'reversal_id' => $reversal['id'], 'replacement_id' => $replacement['id'],
                    'reason' => $data['reason'], 'currency' => $payment->currency,
                    'received_before' => $plan['payment']['received_before'],
                    'received_after' => $plan['payment']['received_after'],
                    'allocated_before' => $plan['payment']['allocated_before'],
                    'allocated_after' => $plan['payment']['allocated_after'],
                    'refunded_amount' => $plan['payment']['refunded_amount'],
                    'available_before' => $plan['payment']['available_before'],
                    'available_after' => $plan['payment']['available_after'],
                    'allocations' => $plan['allocations'],
                    'related_branch_ids' => $affectedBranches,
                    'account_before' => $plan['account']['before'], 'account_after' => $plan['account']['after'],
                ]), 'created_at' => $now,
            ]);

            return response()->json(['reversal' => $reversal, 'replacement' => $replacement,
                'version' => StudentAccountVersion::forActor($studentId, $student->financial_account_revision + 1, $request->user()->id)], 201)
                ->header('Cache-Control', 'private, no-store');
        });
    }

    private function data(Request $request, bool $write): array
    {
        $data = $request->validate([
            'correct_amount' => ['required', 'numeric', 'decimal:0,2', 'min:0', 'max:9999999999.99', 'regex:/^\d{1,10}(?:\.\d{1,2})?$/'],
            'allocations' => ['present', 'array', 'max:20'],
            'allocations.*.id' => ['required', 'uuid', 'distinct'],
            'allocations.*.amount' => ['required', 'numeric', 'decimal:0,2', 'min:0', 'max:9999999999.99', 'regex:/^\d{1,10}(?:\.\d{1,2})?$/'],
            'version' => ['required', 'regex:/^[a-f0-9]{64}$/'],
            ...($write ? ['reason' => ['required', 'string', 'max:2000'], 'request_id' => ['required', 'uuid']] : []),
        ]);
        $data['correct_amount'] = StudentMoney::format(StudentMoney::cents($data['correct_amount']));
        $data['allocations'] = array_map(fn (array $entry) => [
            'id' => $entry['id'], 'amount' => StudentMoney::format(StudentMoney::cents($entry['amount'])),
        ], $data['allocations']);
        usort($data['allocations'], fn (array $a, array $b) => strcmp($a['id'], $b['id']));
        if ($write) {
            $data['reason'] = trim($data['reason']);
            abort_unless($data['reason'] !== '', 422, 'أدخل سبب تصحيح الدفعة.');
        }

        return $data;
    }

    private function payment(string $studentId, string $paymentId, CenterPermissions $permissions, ?int $page = null, int $historyPage = 1): object
    {
        $query = StudentPhotos::visibleStudent($studentId, $permissions, 'finance.read')
            ->join('student_payments as payments', 'payments.student_id', '=', 'students.id')
            ->join('branches', 'branches.id', '=', 'payments.branch_id')
            ->where('payments.id', $paymentId)
            ->select(['payments.id', 'payments.branch_id', 'branches.name as branch_name',
                'payments.currency', 'payments.amount as original_amount', 'students.financial_account_revision'])
            ->selectRaw(EffectiveStudentPayments::amount('payments').' AS amount')
            ->selectSub(ActiveStudentAllocations::query()->whereColumn('allocations.payment_id', 'payments.id')
                ->selectRaw('COALESCE(SUM(allocations.amount), 0)'), 'allocated_amount')
            ->selectSub(ActiveStudentRefunds::query()->whereColumn('refunds.payment_id', 'payments.id')
                ->selectRaw('COALESCE(SUM(refunds.amount), 0)'), 'refunded_amount');
        if ($page !== null) {
            $allocationRows = ActiveStudentAllocations::query()
                ->join('study_attempt_fees as fees', 'fees.id', '=', 'allocations.fee_id')
                ->join('branches as target_branches', 'target_branches.id', '=', 'allocations.target_branch_id')
                ->whereColumn('allocations.payment_id', 'payments.id')
                ->orderBy('allocations.created_at')->orderBy('allocations.id')
                ->offset(($page - 1) * 20)->limit(21)
                ->select(['allocations.id', 'allocations.fee_id', 'allocations.target_branch_id', 'allocations.created_at',
                    'target_branches.name as target_branch_name', 'allocations.amount', 'fees.attempt_id'])
                ->selectRaw(EffectiveStudyFees::amount('fees').' AS fee_due')
                ->selectSub(ActiveStudentAllocations::query()->whereColumn('allocations.fee_id', 'fees.id')
                    ->selectRaw('COALESCE(SUM(allocations.amount), 0)'), 'fee_paid');
            $historyRows = DB::connection('tenant')->table('student_payment_reversals as reversals')
                ->join('student_payment_replacements as replacements', 'replacements.reversal_id', '=', 'reversals.id')
                ->whereColumn('reversals.payment_id', 'payments.id')
                ->orderByDesc('reversals.created_at')->orderByDesc('reversals.id')
                ->offset(($historyPage - 1) * 20)->limit(21)
                ->select(['reversals.id', 'reversals.reason', 'reversals.actor_name', 'reversals.created_at',
                    'replacements.amount']);
            $query->selectSub(ActiveStudentAllocations::query()->whereColumn('allocations.payment_id', 'payments.id')
                ->selectRaw("COALESCE(json_agg(DISTINCT allocations.target_branch_id), '[]'::json)"), 'affected_branches')
                ->selectSub(DB::connection('tenant')->query()->fromSub($allocationRows, 'allocation_rows')
                    ->selectRaw("COALESCE(json_agg(allocation_rows ORDER BY created_at, id), '[]'::json)"), 'allocation_rows')
                ->selectSub(DB::connection('tenant')->query()->fromSub($historyRows, 'history_rows')
                    ->selectRaw("COALESCE(json_agg(history_rows ORDER BY created_at DESC, id DESC), '[]'::json)"), 'history_rows');
        }
        $payment = $query->first();
        abort_unless($payment && $permissions->can('finance.read', (int) $payment->branch_id), 404);

        return $payment;
    }

    private function plan(string $studentId, object $payment, array $data, CenterPermissions $permissions, array $affectedBranches): array
    {
        $ids = array_column($data['allocations'], 'id');
        $rows = $ids ? ActiveStudentAllocations::query()
            ->join('study_attempt_fees as fees', 'fees.id', '=', 'allocations.fee_id')
            ->where('allocations.payment_id', $payment->id)->whereIn('allocations.id', $ids)
            ->select(['allocations.id', 'allocations.fee_id', 'allocations.target_branch_id', 'allocations.amount'])
            ->selectRaw(EffectiveStudyFees::amount('fees').' AS fee_due')
            ->selectSub(ActiveStudentAllocations::query()->whereColumn('allocations.fee_id', 'fees.id')
                ->selectRaw('COALESCE(SUM(allocations.amount), 0)'), 'fee_paid')->get()->keyBy('id') : collect();
        if ($rows->count() !== count($ids)) {
            $this->conflict('allocation_changed');
        }
        $changes = [];
        $delta = 0;
        $feeChanges = [];
        foreach ($data['allocations'] as $entry) {
            $row = $rows[$entry['id']];
            abort_unless($this->canCorrectAllocation($permissions, (int) $payment->branch_id, (int) $row->target_branch_id), 403);
            $before = StudentMoney::cents($row->amount);
            $after = StudentMoney::cents($entry['amount']);
            abort_if($before === $after, 422, 'أدخل التخصيصات التي تتغير فقط.');
            $feeChanges[$row->fee_id] ??= ['due' => StudentMoney::cents($row->fee_due),
                'paid' => StudentMoney::cents($row->fee_paid), 'delta' => 0];
            $feeChanges[$row->fee_id]['delta'] += $after - $before;
            $delta += $after - $before;
            $changes[] = ['id' => $row->id, 'fee_id' => $row->fee_id,
                'target_branch_id' => (int) $row->target_branch_id,
                'amount_before' => StudentMoney::format($before), 'amount_after' => StudentMoney::format($after),
                'fee_debt_before' => StudentMoney::format(StudentMoney::cents($row->fee_due) - StudentMoney::cents($row->fee_paid))];
        }
        foreach ($feeChanges as $fee) {
            if ($fee['due'] < $fee['paid'] + $fee['delta']) {
                $this->conflict('fee_already_paid');
            }
        }
        foreach ($changes as &$change) {
            $fee = $feeChanges[$change['fee_id']];
            $change['fee_debt_after'] = StudentMoney::format($fee['due'] - $fee['paid'] - $fee['delta']);
        }
        unset($change);
        $receivedBefore = StudentMoney::cents($payment->amount);
        $receivedAfter = StudentMoney::cents($data['correct_amount']);
        abort_if($receivedBefore === $receivedAfter, 422, 'يجب أن يتغير مبلغ الدفعة؛ استخدم تصحيح التخصيص المستقل دون تغيير المقبوض.');
        $allocatedBefore = StudentMoney::cents($payment->allocated_amount);
        $allocatedAfter = $allocatedBefore + $delta;
        $refunded = StudentMoney::cents($payment->refunded_amount);
        if ($allocatedAfter + $refunded > $receivedAfter) {
            $this->conflict('payment_not_available');
        }
        $branches = array_values(array_unique(array_merge([(int) $payment->branch_id], $affectedBranches)));
        $account = $this->accountBalance($studentId, $branches);
        $availableDelta = $receivedAfter - $receivedBefore - $delta;

        return [
            'payment' => ['id' => $payment->id, 'branch_id' => (int) $payment->branch_id,
                'branch_name' => $payment->branch_name, 'currency' => $payment->currency,
                'received_before' => StudentMoney::format($receivedBefore),
                'received_after' => StudentMoney::format($receivedAfter),
                'allocated_before' => StudentMoney::format($allocatedBefore),
                'allocated_after' => StudentMoney::format($allocatedAfter),
                'refunded_amount' => StudentMoney::format($refunded),
                'available_before' => StudentMoney::format($receivedBefore - $allocatedBefore - $refunded),
                'available_after' => StudentMoney::format($receivedAfter - $allocatedAfter - $refunded)],
            'allocations' => $changes,
            'account' => ['branch_ids' => $branches,
                'before' => $account,
                'after' => ['available' => StudentMoney::format(StudentMoney::cents($account['available']) + $availableDelta),
                    'debt' => StudentMoney::format(StudentMoney::cents($account['debt']) - $delta)]],
        ];
    }

    private function accountBalance(string $studentId, array $branches): array
    {
        $received = DB::connection('tenant')->table('student_payments')
            ->where('student_id', $studentId)->whereIn('branch_id', $branches)
            ->selectRaw('COALESCE(SUM('.EffectiveStudentPayments::amount().'), 0) AS total')->value('total');
        $used = ActiveStudentAllocations::query()->where('allocations.student_id', $studentId)
            ->whereIn('allocations.source_branch_id', $branches)->sum('allocations.amount');
        $refunded = ActiveStudentRefunds::query()->where('refunds.student_id', $studentId)
            ->whereIn('refunds.branch_id', $branches)->sum('refunds.amount');
        $due = DB::connection('tenant')->table('study_attempt_fees as fees')->where('fees.student_id', $studentId)
            ->whereIn('fees.branch_id', $branches)
            ->selectRaw('COALESCE(SUM('.EffectiveStudyFees::amount('fees').'), 0) AS total')->value('total');
        $paid = ActiveStudentAllocations::query()->where('allocations.student_id', $studentId)
            ->whereIn('allocations.target_branch_id', $branches)->sum('allocations.amount');

        return ['available' => StudentMoney::format(StudentMoney::cents($received) - StudentMoney::cents($used) - StudentMoney::cents($refunded)),
            'debt' => StudentMoney::format(StudentMoney::cents($due) - StudentMoney::cents($paid))];
    }

    private function balance(object $payment): array
    {
        $received = StudentMoney::cents($payment->amount);
        $allocated = StudentMoney::cents($payment->allocated_amount);
        $refunded = StudentMoney::cents($payment->refunded_amount);

        return ['id' => $payment->id, 'branch_id' => (int) $payment->branch_id,
            'branch_name' => $payment->branch_name, 'currency' => $payment->currency,
            'received_before' => StudentMoney::format($received), 'allocated_before' => StudentMoney::format($allocated),
            'refunded_amount' => StudentMoney::format($refunded),
            'available_before' => StudentMoney::format($received - $allocated - $refunded)];
    }

    private function checkAffectedBranches(string $paymentId, int $sourceBranchId, CenterPermissions $permissions, bool $forCorrection = true): array
    {
        $branches = ActiveStudentAllocations::query()->where('allocations.payment_id', $paymentId)
            ->distinct()->pluck('allocations.target_branch_id');
        foreach ($branches as $branchId) {
            abort_unless($permissions->can('finance.read', (int) $branchId), 404);
            if ($forCorrection) {
                abort_unless($this->canCorrectAllocation($permissions, $sourceBranchId, (int) $branchId), 403);
            }
        }

        return $branches->map(fn ($branchId): int => (int) $branchId)->all();
    }

    private function canCorrect(CenterPermissions $permissions, int $branchId): bool
    {
        return $permissions->can('payments.correct', $branchId);
    }

    private function canCorrectAllocation(CenterPermissions $permissions, int $source, int $target): bool
    {
        return $permissions->can('payments.correct', $source)
            && $permissions->can('payments.allocate', $source)
            && $permissions->can('payments.correct', $target)
            && $permissions->can('finance.read', $target)
            && ($source === $target || ($permissions->can('payments.allocate', $target)
                && $permissions->can('finance.approve', $source)
                && $permissions->can('finance.approve', $target)));
    }

    private function checkVersion(string $studentId, int $revision, Request $request, string $version): void
    {
        if (! hash_equals(StudentAccountVersion::forActor($studentId, $revision, $request->user()->id), $version)) {
            $this->conflict('student_account_changed');
        }
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
