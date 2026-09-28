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
        $historyQuery = DB::connection('tenant')->table('student_payment_allocations as allocations')
            ->join('study_attempt_fees as fees', 'fees.id', '=', 'allocations.fee_id')
            ->leftJoin('student_payment_allocation_reversals as reversals', 'reversals.allocation_id', '=', 'allocations.id')
            ->whereColumn('allocations.payment_id', 'payments.id')->where('allocations.student_id', $studentId)
            ->when(isset($data['allocation_id']), fn ($query) => $query->where('allocations.id', $data['allocation_id']))
            ->orderByDesc('allocations.created_at')->orderByDesc('allocations.id')
            ->offset(isset($data['allocation_id']) ? 0 : ($historyPage - 1) * 20)->limit(21)
            ->select(['allocations.id', 'allocations.fee_id', 'allocations.currency', 'allocations.actor_name',
                'allocations.created_at', 'fees.attempt_id', 'fees.created_at as fee_created_at',
                'reversals.id as reversal_id', 'reversals.reason as reversal_reason',
                'reversals.actor_name as reversed_by_name', 'reversals.created_at as reversed_at'])
            ->selectRaw('allocations.amount::text as amount')
            ->selectSub($this->originalFeeGroupName(), 'group_name');
        $payment = StudentPhotos::visibleStudent($studentId, $permissions, 'finance.read')
            ->join('student_payments as payments', 'payments.student_id', '=', 'students.id')
            ->where('payments.id', $paymentId)
            ->select(['payments.id', 'payments.branch_id', 'payments.amount', 'payments.currency',
                'students.financial_account_revision'])
            ->selectSub(ActiveStudentAllocations::query()->whereColumn('allocations.payment_id', 'payments.id')
                ->selectRaw('COALESCE(SUM(allocations.amount), 0)'), 'used_amount')
            ->selectSub(DB::connection('tenant')->query()->fromSub($historyQuery, 'history_rows')
                ->selectRaw("COALESCE(json_agg(history_rows ORDER BY created_at DESC, id DESC), '[]'::json)"), 'history_rows')->first();
        abort_unless($payment && $permissions->can('finance.read', (int) $payment->branch_id), 404);

        $history = collect(json_decode($payment->history_rows ?? '[]'));
        $fees = DB::connection('tenant')->table('study_attempt_fees as fees')
            ->where('fees.student_id', $studentId)->where('fees.branch_id', $payment->branch_id)
            ->orderByDesc('fees.created_at')->orderByDesc('fees.id')
            ->offset(($page - 1) * 20)->limit(21)
            ->select(['fees.id', 'fees.attempt_id', 'fees.branch_id', 'fees.net_amount', 'fees.currency',
                'fees.created_at as fee_created_at'])
            ->selectRaw(EffectiveStudyFees::amount('fees').' AS current_due')
            ->selectSub($this->originalFeeGroupName(), 'group_name')
            ->selectSub(ActiveStudentAllocations::query()->whereColumn('allocations.fee_id', 'fees.id')
                ->selectRaw('COALESCE(SUM(allocations.amount), 0)'), 'paid_amount')->get();

        return response()->json([
            'payment' => ['id' => $payment->id, 'branch_id' => (int) $payment->branch_id,
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
            'history' => $history->take(20)->values(),
            'pagination' => ['page' => $page, 'has_more' => $fees->count() > 20,
                'history_page' => $historyPage, 'history_has_more' => $history->count() > 20],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function allocate(Request $request, string $studentId, string $paymentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($paymentId), 404);
        $data = $request->validate([
            'targets' => ['required', 'array', 'min:1', 'max:20'],
            'targets.*.attempt_id' => ['required', 'uuid', 'distinct'],
            'targets.*.amount' => ['required', 'numeric', 'decimal:0,2', 'gt:0', 'max:9999999999.99', 'regex:/^\d{1,10}(?:\.\d{1,2})?$/'],
            'version' => ['required', 'regex:/^[a-f0-9]{64}$/'],
            'request_id' => ['required', 'uuid'],
        ]);
        $targets = array_map(fn (array $target): array => ['attempt_id' => $target['attempt_id'],
            'amount' => StudentMoney::format(StudentMoney::cents($target['amount']))], $data['targets']);
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

                return response()->json(['allocations' => DB::connection('tenant')->table('student_payment_allocations')
                    ->whereIn('id', json_decode($existing->allocation_ids, true))->get(),
                    'version' => StudentAccountVersion::forActor($studentId, $student->financial_account_revision, $request->user()->id)]);
            }
            if (! hash_equals(StudentAccountVersion::forActor($studentId, $student->financial_account_revision, $request->user()->id), $data['version'])) {
                $this->conflict('student_account_changed');
            }
            $sum = array_sum(array_map(fn (array $target): int => StudentMoney::cents($target['amount']), $targets));
            $availableBefore = StudentMoney::cents($payment->amount) - $this->used($paymentId);
            if ($sum > $availableBefore) {
                $this->conflict('payment_not_available');
            }
            $fees = DB::connection('tenant')->table('study_attempt_fees')->where('student_id', $studentId)
                ->where('branch_id', $payment->branch_id)
                ->whereIn('attempt_id', array_column($targets, 'attempt_id'))
                ->select(['id', 'attempt_id', 'net_amount', 'currency'])
                ->selectRaw(EffectiveStudyFees::amount('study_attempt_fees').' AS current_due')
                ->selectSub(ActiveStudentAllocations::query()->whereColumn('allocations.fee_id', 'study_attempt_fees.id')
                    ->selectRaw('COALESCE(SUM(allocations.amount), 0)'), 'paid_amount')
                ->get()->keyBy('attempt_id');
            abort_unless($fees->count() === count($targets), 404);
            $ids = [];
            $rows = [];
            $auditAllocations = [];
            foreach ($targets as $target) {
                $fee = $fees->get($target['attempt_id']);
                abort_unless($fee && $fee->currency === $payment->currency, 422, 'عملة الرسوم لا تطابق الدفعة.');
                $amount = StudentMoney::cents($target['amount']);
                $alreadyPaid = StudentMoney::cents($fee->paid_amount);
                $dueBefore = StudentMoney::cents($fee->current_due) - $alreadyPaid;
                if ($amount > $dueBefore) {
                    $this->conflict('fee_already_paid');
                }
                $id = (string) Str::uuid();
                $ids[] = $id;
                $rows[] = ['id' => $id, 'student_id' => $studentId, 'payment_id' => $paymentId,
                    'fee_id' => $fee->id, 'source_branch_id' => $payment->branch_id,
                    'target_branch_id' => $payment->branch_id, 'amount' => $target['amount'],
                    'currency' => $payment->currency, 'actor_id' => $request->user()->id,
                    'actor_name' => $request->user()->name, 'submission_id' => $data['request_id'], 'created_at' => now()];
                $auditAllocations[] = ['id' => $id, 'fee_id' => $fee->id, 'attempt_id' => $target['attempt_id'],
                    'amount' => $target['amount'], 'fee_due_before' => StudentMoney::format($dueBefore),
                    'fee_due_after' => StudentMoney::format($dueBefore - $amount)];
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
                    'branch_id' => $payment->branch_id, 'allocations' => $auditAllocations,
                    'payment_available_before' => StudentMoney::format($availableBefore),
                    'payment_available_after' => StudentMoney::format($availableBefore - $sum),
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
        $payment = DB::connection('tenant')->table('student_payments')->where('id', $paymentId)
            ->where('student_id', $studentId)->first();
        abort_unless($payment && $permissions->can('finance.read', (int) $payment->branch_id), 404);

        return $payment;
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
