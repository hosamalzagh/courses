<?php

namespace App\Http\Controllers;

use App\Support\ActiveStudentAllocations;
use App\Support\ActiveStudentRefunds;
use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\EffectiveStudentPayments;
use App\Support\StudentAccountVersion;
use App\Support\StudentMoney;
use App\Support\StudentPhotos;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class CenterStudentRefundController extends Controller
{
    public function index(Request $request, string $studentId, string $paymentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($paymentId), 404);
        $data = $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $permissions = $request->attributes->get('center_permissions');
        $page = (int) ($data['page'] ?? 1);
        $historyQuery = DB::connection('tenant')->table('student_refunds as refunds')
            ->leftJoin('student_refund_reversals as reversals', 'reversals.refund_id', '=', 'refunds.id')
            ->leftJoin('student_refund_submissions as submissions', 'submissions.request_id', '=', 'reversals.submission_id')
            ->leftJoin('student_refunds as replacements', 'replacements.submission_id', '=', 'reversals.submission_id')
            ->where('refunds.student_id', $studentId)->whereColumn('refunds.payment_id', 'payments.id')
            ->orderByDesc('refunds.created_at')->orderByDesc('refunds.id')
            ->offset(($page - 1) * 20)->limit(21)
            ->select(['refunds.id', 'refunds.branch_id', 'refunds.currency', 'refunds.refunded_on',
                'refunds.reason', 'refunds.actor_name', 'refunds.created_at',
                'reversals.id as reversal_id', 'reversals.reason as correction_reason',
                'reversals.actor_name as corrected_by_name', 'reversals.created_at as corrected_at',
                'submissions.kind as reversal_kind', 'replacements.id as replacement_refund_id'])
            ->selectRaw('refunds.amount::text AS amount')
            ->selectRaw('replacements.amount::text AS replacement_amount');
        $payment = StudentPhotos::visibleStudent($studentId, $permissions, 'finance.read')
            ->join('student_payments as payments', 'payments.student_id', '=', 'students.id')
            ->join('branches', 'branches.id', '=', 'payments.branch_id')
            ->where('payments.id', $paymentId)
            ->select(['payments.id', 'payments.branch_id', 'payments.currency',
                'payments.received_on', 'branches.name as branch_name', 'students.financial_account_revision'])
            ->selectRaw(EffectiveStudentPayments::amount('payments').' AS amount')
            ->selectSub(ActiveStudentAllocations::query()->whereColumn('allocations.payment_id', 'payments.id')
                ->selectRaw('COALESCE(SUM(allocations.amount), 0)'), 'allocated_amount')
            ->selectSub(ActiveStudentRefunds::query()->whereColumn('refunds.payment_id', 'payments.id')
                ->selectRaw('COALESCE(SUM(refunds.amount), 0)'), 'refunded_amount')
            ->selectSub(DB::connection('tenant')->query()->fromSub($historyQuery, 'history_rows')
                ->selectRaw("COALESCE(json_agg(history_rows ORDER BY created_at DESC, id DESC), '[]'::json)"), 'history_rows')
            ->first();
        abort_unless($payment && $permissions->can('finance.read', (int) $payment->branch_id), 404);
        $allocated = StudentMoney::cents($payment->allocated_amount);
        $refunded = StudentMoney::cents($payment->refunded_amount);
        $plan = ['id' => $payment->id, 'branch_id' => (int) $payment->branch_id,
            'branch_name' => $payment->branch_name, 'received_amount' => $payment->amount,
            'received_on' => $payment->received_on, 'currency' => $payment->currency,
            'allocated_amount' => StudentMoney::format($allocated),
            'refunded_amount' => StudentMoney::format($refunded),
            'available_before' => StudentMoney::format(StudentMoney::cents($payment->amount) - $allocated - $refunded)];
        $history = collect(json_decode($payment->history_rows ?? '[]', true));

        return response()->json([
            'payment' => $plan,
            'version' => StudentAccountVersion::forActor($studentId, $payment->financial_account_revision, $request->user()->id),
            'can_refund' => $this->canRecord($permissions, (int) $payment->branch_id),
            'can_correct' => $this->canCorrect($permissions, (int) $payment->branch_id),
            'history' => $history->take(20),
            'pagination' => ['page' => $page, 'has_more' => $history->count() > 20],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function preview(Request $request, string $studentId, string $paymentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($paymentId), 404);
        $data = $this->refundData($request, false);
        $permissions = $request->attributes->get('center_permissions');
        $payment = $this->visiblePayment($studentId, $paymentId, $permissions);
        abort_unless($this->canRecord($permissions, (int) $payment->branch_id), 403);
        $this->checkRefundDate($data['refunded_on'], $payment->received_on);
        $student = StudentPhotos::visibleStudent($studentId, $permissions, 'payments.record')
            ->first(['students.id', 'students.financial_account_revision']);
        abort_unless($student, 404);
        $this->checkVersion($studentId, (int) $student->financial_account_revision, $request, $data['version']);
        $balance = $this->paymentBalance($payment);
        $amount = StudentMoney::cents($data['amount']);
        if ($amount > StudentMoney::cents($balance['available_before'])) {
            $this->conflict('refund_exceeds_available');
        }

        return response()->json(['payment' => $balance, 'amount' => $data['amount'],
            'refunded_on' => $data['refunded_on'], 'reason' => $data['reason'],
            'available_after' => StudentMoney::format(StudentMoney::cents($balance['available_before']) - $amount),
            'version' => $data['version']])->header('Cache-Control', 'private, no-store');
    }

    public function record(Request $request, string $studentId, string $paymentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($paymentId), 404);
        $data = $this->refundData($request, true);
        $hash = hash('sha256', json_encode([$studentId, $paymentId, $data['amount'], $data['refunded_on'], $data['reason']]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $paymentId, $data, $hash): JsonResponse {
            $payment = $this->visiblePayment($studentId, $paymentId, $permissions);
            abort_unless($this->canRecord($permissions, (int) $payment->branch_id), 403);
            $this->checkRefundDate($data['refunded_on'], $payment->received_on);
            $student = StudentPhotos::visibleStudent($studentId, $permissions, 'payments.record')
                ->lockForUpdate()->first(['students.id', 'students.financial_account_revision']);
            abort_unless($student, 404);
            $existing = DB::connection('tenant')->table('student_refund_submissions')
                ->where('request_id', $data['request_id'])->first();
            if ($existing) {
                abort_unless($existing->student_id === $studentId && $existing->payment_id === $paymentId
                    && $existing->actor_id === $request->user()->id, 403);
                if ($existing->kind !== 'refund' || $existing->request_hash !== $hash) {
                    $this->conflict('refund_request_changed');
                }

                return response()->json(['refund' => DB::connection('tenant')->table('student_refunds')
                    ->where('submission_id', $data['request_id'])->firstOrFail(),
                    'version' => StudentAccountVersion::forActor($studentId, $student->financial_account_revision, $request->user()->id)]);
            }
            $this->checkVersion($studentId, (int) $student->financial_account_revision, $request, $data['version']);
            $balance = $this->paymentBalance($payment);
            if (StudentMoney::cents($data['amount']) > StudentMoney::cents($balance['available_before'])) {
                $this->conflict('refund_exceeds_available');
            }
            $now = now();
            $refund = ['id' => (string) Str::uuid(), 'student_id' => $studentId, 'payment_id' => $paymentId,
                'branch_id' => (int) $payment->branch_id, 'amount' => $data['amount'], 'currency' => $payment->currency,
                'refunded_on' => $data['refunded_on'], 'reason' => $data['reason'],
                'actor_id' => $request->user()->id, 'actor_name' => $request->user()->name,
                'submission_id' => $data['request_id'], 'created_at' => $now];
            DB::connection('tenant')->table('student_refund_submissions')->insert([
                'request_id' => $data['request_id'], 'student_id' => $studentId, 'payment_id' => $paymentId,
                'kind' => 'refund', 'request_hash' => $hash, 'actor_id' => $request->user()->id,
                'refund_ids' => json_encode([$refund['id']]), 'created_at' => $now,
            ]);
            DB::connection('tenant')->table('student_refunds')->insert($refund);
            DB::connection('tenant')->table('students')->where('id', $studentId)->update([
                'financial_account_revision' => $student->financial_account_revision + 1,
            ]);
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'branch_id' => $payment->branch_id,
                'event' => 'student.refund_recorded', 'details' => json_encode([
                    'student_id' => $studentId, 'payment_id' => $paymentId, 'refund_id' => $refund['id'],
                    'received_amount' => $payment->amount, 'allocated_amount' => $balance['allocated_amount'],
                    'refunded_amount_before' => $balance['refunded_amount'],
                    'refunded_amount_after' => StudentMoney::format(StudentMoney::cents($balance['refunded_amount'])
                        + StudentMoney::cents($data['amount'])),
                    'available_before' => $balance['available_before'],
                    'available_after' => StudentMoney::format(StudentMoney::cents($balance['available_before'])
                        - StudentMoney::cents($data['amount'])),
                    'amount' => $data['amount'], 'currency' => $payment->currency,
                    'refunded_on' => $data['refunded_on'], 'reason' => $data['reason'],
                ]), 'created_at' => $now,
            ]);

            return response()->json(['refund' => $refund,
                'version' => StudentAccountVersion::forActor($studentId, $student->financial_account_revision + 1, $request->user()->id)], 201)
                ->header('Cache-Control', 'private, no-store');
        });
    }

    public function correctionPreview(Request $request, string $studentId, string $refundId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($refundId), 404);
        $data = $this->correctionData($request, false);
        $permissions = $request->attributes->get('center_permissions');
        [$refund, $payment] = $this->visibleRefund($studentId, $refundId, $permissions);
        abort_unless($this->canCorrect($permissions, (int) $payment->branch_id), 403);
        $student = StudentPhotos::visibleStudent($studentId, $permissions, 'payments.correct')
            ->first(['students.id', 'students.financial_account_revision']);
        abort_unless($student, 404);
        $this->checkVersion($studentId, (int) $student->financial_account_revision, $request, $data['version']);

        return response()->json([...$this->correctionPlan($refund, $payment, $data['correct_amount']),
            'version' => $data['version']])->header('Cache-Control', 'private, no-store');
    }

    public function correct(Request $request, string $studentId, string $refundId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($refundId), 404);
        $data = $this->correctionData($request, true);
        $hash = hash('sha256', json_encode([$studentId, $refundId, $data['correct_amount'], $data['reason']]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $refundId, $data, $hash): JsonResponse {
            [$refund, $payment] = $this->visibleRefund($studentId, $refundId, $permissions);
            abort_unless($this->canCorrect($permissions, (int) $payment->branch_id), 403);
            $student = StudentPhotos::visibleStudent($studentId, $permissions, 'payments.correct')
                ->lockForUpdate()->first(['students.id', 'students.financial_account_revision']);
            abort_unless($student, 404);
            $existing = DB::connection('tenant')->table('student_refund_submissions')
                ->where('request_id', $data['request_id'])->first();
            if ($existing) {
                abort_unless($existing->student_id === $studentId && $existing->payment_id === $payment->id
                    && $existing->actor_id === $request->user()->id, 403);
                if ($existing->kind !== 'correct' || $existing->request_hash !== $hash) {
                    $this->conflict('refund_request_changed');
                }

                return response()->json(['reversal' => DB::connection('tenant')->table('student_refund_reversals')
                    ->where('refund_id', $refundId)->where('submission_id', $data['request_id'])->firstOrFail(),
                    'replacement' => DB::connection('tenant')->table('student_refunds')
                        ->where('submission_id', $data['request_id'])->first(),
                    'version' => StudentAccountVersion::forActor($studentId, $student->financial_account_revision, $request->user()->id)]);
            }
            $this->checkVersion($studentId, (int) $student->financial_account_revision, $request, $data['version']);
            $plan = $this->correctionPlan($refund, $payment, $data['correct_amount']);
            $now = now();
            $replacement = StudentMoney::cents($data['correct_amount']) === 0 ? null : [
                'id' => (string) Str::uuid(), 'student_id' => $studentId, 'payment_id' => $payment->id,
                'branch_id' => (int) $payment->branch_id, 'amount' => $data['correct_amount'],
                'currency' => $payment->currency, 'refunded_on' => $refund->refunded_on,
                'reason' => $refund->reason, 'actor_id' => $request->user()->id,
                'actor_name' => $request->user()->name, 'submission_id' => $data['request_id'], 'created_at' => $now,
            ];
            $reversal = ['id' => (string) Str::uuid(), 'refund_id' => $refundId, 'student_id' => $studentId,
                'reason' => $data['reason'], 'actor_id' => $request->user()->id,
                'actor_name' => $request->user()->name, 'submission_id' => $data['request_id'], 'created_at' => $now];
            DB::connection('tenant')->table('student_refund_submissions')->insert([
                'request_id' => $data['request_id'], 'student_id' => $studentId, 'payment_id' => $payment->id,
                'kind' => 'correct', 'request_hash' => $hash, 'actor_id' => $request->user()->id,
                'refund_ids' => json_encode(array_values(array_filter([$refundId, $replacement['id'] ?? null]))),
                'created_at' => $now,
            ]);
            DB::connection('tenant')->table('student_refund_reversals')->insert($reversal);
            if ($replacement !== null) {
                DB::connection('tenant')->table('student_refunds')->insert($replacement);
            }
            DB::connection('tenant')->table('students')->where('id', $studentId)->update([
                'financial_account_revision' => $student->financial_account_revision + 1,
            ]);
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'branch_id' => $payment->branch_id,
                'event' => 'student.refund_corrected', 'details' => json_encode([
                    'student_id' => $studentId, 'payment_id' => $payment->id,
                    'original_refund_id' => $refundId, 'reversal_id' => $reversal['id'],
                    'replacement_refund_id' => $replacement['id'] ?? null,
                    'original_amount' => $refund->amount, 'correct_amount' => $data['correct_amount'],
                    'currency' => $payment->currency, 'refunded_on' => $refund->refunded_on,
                    'reason' => $data['reason'], 'payment_before' => $plan['payment'],
                    'available_after' => $plan['available_after'],
                    'later_movements' => $plan['later_movements'],
                ]), 'created_at' => $now,
            ]);

            return response()->json(['reversal' => $reversal, 'replacement' => $replacement,
                'version' => StudentAccountVersion::forActor($studentId, $student->financial_account_revision + 1, $request->user()->id)], 201)
                ->header('Cache-Control', 'private, no-store');
        });
    }

    private function visiblePayment(string $studentId, string $paymentId, CenterPermissions $permissions): object
    {
        $payment = DB::connection('tenant')->table('student_payments as payments')
            ->join('branches', 'branches.id', '=', 'payments.branch_id')
            ->where('payments.id', $paymentId)->where('payments.student_id', $studentId)
            ->select(['payments.*', 'branches.name as branch_name'])
            ->selectRaw(EffectiveStudentPayments::amount('payments').' AS effective_amount')->first();
        abort_unless($payment && $permissions->can('finance.read', (int) $payment->branch_id), 404);
        $payment->amount = $payment->effective_amount;

        return $payment;
    }

    private function visibleRefund(string $studentId, string $refundId, CenterPermissions $permissions): array
    {
        $refund = DB::connection('tenant')->table('student_refunds')
            ->where('id', $refundId)->where('student_id', $studentId)->first();
        abort_unless($refund, 404);
        $payment = $this->visiblePayment($studentId, $refund->payment_id, $permissions);

        return [$refund, $payment];
    }

    private function paymentBalance(object $payment): array
    {
        $allocated = StudentMoney::cents(ActiveStudentAllocations::query()
            ->where('allocations.payment_id', $payment->id)->sum('allocations.amount'));
        $refunded = StudentMoney::cents(ActiveStudentRefunds::query()
            ->where('refunds.payment_id', $payment->id)->sum('refunds.amount'));

        return ['id' => $payment->id, 'branch_id' => (int) $payment->branch_id,
            'branch_name' => $payment->branch_name, 'received_amount' => $payment->amount,
            'received_on' => $payment->received_on, 'currency' => $payment->currency,
            'allocated_amount' => StudentMoney::format($allocated),
            'refunded_amount' => StudentMoney::format($refunded),
            'available_before' => StudentMoney::format(StudentMoney::cents($payment->amount) - $allocated - $refunded)];
    }

    private function correctionPlan(object $refund, object $payment, string $correctAmount): array
    {
        if (DB::connection('tenant')->table('student_refund_reversals')->where('refund_id', $refund->id)->exists()) {
            $this->conflict('refund_already_corrected');
        }
        abort_if(StudentMoney::cents($correctAmount) === StudentMoney::cents($refund->amount),
            422, 'أدخل المبلغ المعاد فعليًا المختلف عن السجل الأصلي.');
        $balance = $this->paymentBalance($payment);
        $availableAfter = StudentMoney::cents($balance['available_before'])
            + StudentMoney::cents($refund->amount) - StudentMoney::cents($correctAmount);
        if ($availableAfter < 0) {
            $this->conflict('refund_exceeds_available');
        }
        $later = DB::connection('tenant')->table('center_audit_logs')
            ->where('created_at', '>=', $refund->created_at)
            ->where('details->payment_id', $payment->id)
            ->whereIn('event', ['student.payment_allocated', 'student.payment_allocation_reversed',
                'student.payment_allocation_corrected', 'student.payment_corrected',
                'student.refund_recorded', 'student.refund_corrected'])
            ->orderByDesc('id')->limit(21)->select(['id', 'event', 'created_at'])
            ->selectRaw("details->>'refund_id' AS refund_id")
            ->selectRaw("details->>'replacement_refund_id' AS replacement_refund_id")
            ->get()->reject(fn (object $row): bool => $row->refund_id === $refund->id
                || $row->replacement_refund_id === $refund->id)
            ->take(20)->map(fn (object $row): array => ['id' => $row->id, 'event' => $row->event,
                'created_at' => $row->created_at])->values();

        return ['original' => ['id' => $refund->id, 'amount' => $refund->amount,
            'refunded_on' => $refund->refunded_on, 'reason' => $refund->reason, 'actor_name' => $refund->actor_name],
            'payment' => $balance, 'correct_amount' => $correctAmount,
            'available_after' => StudentMoney::format($availableAfter),
            'later_movements' => $later];
    }

    private function refundData(Request $request, bool $withRequestId): array
    {
        $data = $request->validate([
            'amount' => ['required', 'numeric', 'decimal:0,2', 'gt:0', 'max:9999999999.99', 'regex:/^\d{1,10}(?:\.\d{1,2})?$/'],
            'refunded_on' => ['required', 'date_format:Y-m-d'],
            'reason' => ['required', 'string', 'max:2000'],
            'version' => ['required', 'regex:/^[a-f0-9]{64}$/'],
            ...($withRequestId ? ['request_id' => ['required', 'uuid']] : []),
        ]);
        $data['amount'] = StudentMoney::format(StudentMoney::cents($data['amount']));
        $data['reason'] = trim($data['reason']);
        abort_unless($data['reason'] !== '', 422, 'أدخل سبب رد المبلغ فعليًا.');

        return $data;
    }

    private function correctionData(Request $request, bool $withRequestId): array
    {
        $data = $request->validate([
            'correct_amount' => ['required', 'numeric', 'decimal:0,2', 'min:0', 'max:9999999999.99', 'regex:/^\d{1,10}(?:\.\d{1,2})?$/'],
            'version' => ['required', 'regex:/^[a-f0-9]{64}$/'],
            ...($withRequestId ? ['reason' => ['required', 'string', 'max:2000'], 'request_id' => ['required', 'uuid']] : []),
        ]);
        $data['correct_amount'] = StudentMoney::format(StudentMoney::cents($data['correct_amount']));
        if ($withRequestId) {
            $data['reason'] = trim($data['reason']);
            abort_unless($data['reason'] !== '', 422, 'أدخل سبب تصحيح الاسترداد.');
        }

        return $data;
    }

    private function canRecord(CenterPermissions $permissions, int $branchId): bool
    {
        return $permissions->can('payments.record', $branchId) && $permissions->can('finance.approve', $branchId);
    }

    private function checkRefundDate(string $refundedOn, string $receivedOn): void
    {
        if ($refundedOn < $receivedOn) {
            throw ValidationException::withMessages(['refunded_on' => 'تاريخ رد المبلغ لا يسبق تاريخ استلام الدفعة.']);
        }
    }

    private function canCorrect(CenterPermissions $permissions, int $branchId): bool
    {
        return $permissions->can('payments.correct', $branchId) && $permissions->can('finance.approve', $branchId);
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
