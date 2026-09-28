<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\StudentPhotos;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudentFinanceController extends Controller
{
    private const CURRENCIES = ['EGP', 'SAR', 'AED', 'USD', 'EUR', 'GBP'];

    public function account(Request $request, string $studentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId), 404);
        $data = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'branches_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'q' => ['sometimes', 'string', 'max:100'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        $readable = $this->scope($permissions, 'finance.read');
        $recordable = $this->scope($permissions, 'payments.record');
        $branchPage = (int) ($data['branches_page'] ?? 1);
        $choices = DB::connection('tenant')->table('student_branches')
            ->join('branches', 'branches.id', '=', 'student_branches.branch_id')
            ->whereColumn('student_branches.student_id', 'students.id')
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('branches.id', $recordable))
            ->orderBy('branches.id')->offset(($branchPage - 1) * 50)->limit(51)
            ->select(['branches.id', 'branches.name']);
        $balance = DB::connection('tenant')->table('student_payments')
            ->whereColumn('student_payments.student_id', 'students.id')
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('student_payments.branch_id', $readable))
            ->selectRaw('COALESCE(SUM(student_payments.amount), 0)');
        $debt = DB::connection('tenant')->table('study_attempt_fees')
            ->whereColumn('study_attempt_fees.student_id', 'students.id')
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('study_attempt_fees.branch_id', $readable))
            ->selectRaw('COALESCE(SUM(study_attempt_fees.net_amount), 0)');
        $student = StudentPhotos::visibleStudent($studentId, $permissions, 'finance.read')
            ->select(['students.id', 'students.name', 'students.student_number', 'students.financial_account_revision'])
            ->selectSub(DB::connection('tenant')->table('center_settings')->where('id', 1)->select('financial_currency'), 'currency')
            ->selectSub(DB::connection('tenant')->table('center_settings')->where('id', 1)->select('financial_currency_revision'), 'currency_revision')
            ->selectSub(DB::connection('tenant')->table('center_settings')->where('id', 1)->select('financial_currency_locked_at'), 'currency_locked_at')
            ->selectSub($balance, 'available_balance')
            ->selectSub($debt, 'debt')
            ->selectSub(DB::connection('tenant')->query()->fromSub($choices, 'branch_choices')->selectRaw('json_agg(branch_choices)'), 'recordable_branches')
            ->first();
        abort_unless($student, 404);
        $branches = collect(json_decode($student->recordable_branches ?? '[]', true));
        $page = (int) ($data['page'] ?? 1);
        $search = trim($data['q'] ?? '');
        $payments = DB::connection('tenant')->table('student_payments')
            ->join('branches', 'branches.id', '=', 'student_payments.branch_id')
            ->where('student_payments.student_id', $studentId)
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('student_payments.branch_id', $readable))
            ->when($search !== '', function (Builder $query) use ($search): void {
                $pattern = '%'.addcslashes($search, '%_\\').'%';
                $methodLabels = ['cash' => 'نقدًا', 'bank_transfer' => 'تحويل بنكي', 'bank_card' => 'بطاقة بنكية', 'mobile_wallet' => 'محفظة إلكترونية'];
                $matchingMethods = array_keys(array_filter($methodLabels, fn (string $label): bool => mb_stripos($label, $search) !== false));
                $query->where(function (Builder $match) use ($pattern, $matchingMethods): void {
                    $match->where('branches.name', 'ILIKE', $pattern)
                        ->orWhere('student_payments.actor_name', 'ILIKE', $pattern)
                        ->orWhere('student_payments.method', 'ILIKE', $pattern)
                        ->orWhereIn('student_payments.method', $matchingMethods)
                        ->orWhereRaw('student_payments.received_on::text ILIKE ?', [$pattern])
                        ->orWhereRaw('student_payments.amount::text ILIKE ?', [$pattern]);
                });
            })
            ->orderByDesc('student_payments.created_at')->orderByDesc('student_payments.id')
            ->offset(($page - 1) * 20)->limit(21)
            ->get(['student_payments.id', 'student_payments.branch_id', 'branches.name as branch_name',
                'student_payments.amount', 'student_payments.currency', 'student_payments.method',
                'student_payments.received_on', 'student_payments.actor_name', 'student_payments.created_at']);

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(),
            'account' => [
                'student_id' => $student->id, 'student_name' => $student->name, 'student_number' => (int) $student->student_number,
                'version' => $this->accountVersion($student->id, $student->financial_account_revision, $request->user()->id),
                'currency' => $student->currency, 'currency_revision' => (int) $student->currency_revision,
                'currency_locked' => $student->currency_locked_at !== null,
                'available_balance' => $student->available_balance,
                'debt' => $student->debt,
            ],
            'recordable_branches' => $branches->take(50)->values(),
            'payments' => $payments->take(20)->values(),
            'pagination' => [
                'page' => $page, 'has_more' => $payments->count() > 20,
                'branches_page' => $branchPage, 'branches_has_more' => $branches->count() > 50,
            ],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function updateCurrency(Request $request): JsonResponse
    {
        $data = $request->validate([
            'currency' => ['required', 'in:'.implode(',', self::CURRENCIES)],
            'revision' => ['required', 'integer', 'min:1'],
        ]);

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $data): JsonResponse {
            abort_unless($permissions->isCenterManager(), 403);
            $settings = DB::connection('tenant')->table('center_settings')->where('id', 1)->lockForUpdate()->first();
            abort_unless($settings, 503);
            if ($settings->financial_currency === $data['currency']) {
                return response()->json(['currency' => $settings->financial_currency, 'revision' => $settings->financial_currency_revision]);
            }
            if ($settings->financial_currency_locked_at !== null || $settings->financial_currency_revision !== (int) $data['revision']) {
                $this->conflict('currency_locked_or_changed');
            }
            DB::connection('tenant')->table('center_settings')->where('id', 1)->update([
                'financial_currency' => $data['currency'],
                'financial_currency_revision' => $settings->financial_currency_revision + 1,
                'updated_at' => now(),
            ]);
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'event' => 'center.financial_currency_changed',
                'details' => json_encode(['before' => $settings->financial_currency, 'after' => $data['currency']]), 'created_at' => now(),
            ]);

            return response()->json(['currency' => $data['currency'], 'revision' => $settings->financial_currency_revision + 1]);
        })->header('Cache-Control', 'private, no-store');
    }

    public function recordPayment(Request $request, string $studentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId), 404);
        $data = $request->validate([
            'branch_id' => ['required', 'integer', 'min:1'],
            'method' => ['required', 'in:cash,bank_transfer,bank_card,mobile_wallet'],
            'received_on' => ['required', 'date_format:Y-m-d'],
            'amount' => ['required', 'numeric', 'decimal:0,2', 'gt:0', 'max:9999999999.99'],
            'request_id' => ['required', 'uuid'],
            'version' => ['required', 'regex:/^[a-f0-9]{64}$/'],
        ]);
        $data['amount'] = $this->amount($data['amount']);
        $hash = hash('sha256', json_encode([$studentId, $data['branch_id'], $data['method'], $data['received_on'], $data['amount']]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $data, $hash): JsonResponse {
            abort_unless($permissions->can('payments.record', (int) $data['branch_id']), 403);
            $student = StudentPhotos::visibleStudent($studentId, $permissions, 'payments.record')
                ->whereExists(DB::connection('tenant')->table('student_branches')
                    ->whereColumn('student_branches.student_id', 'students.id')->where('student_branches.branch_id', $data['branch_id'])->selectRaw('1'))
                ->lockForUpdate()->first(['students.id', 'students.financial_account_revision']);
            abort_unless($student, 404);
            $settings = DB::connection('tenant')->table('center_settings')->where('id', 1)->lockForUpdate()->first();
            abort_unless($settings, 503);
            abort_if($settings->financial_currency === null, 409, 'اختر عملة المركز قبل استلام الدفعة.');
            $existing = DB::connection('tenant')->table('student_payments')->where('request_id', $data['request_id'])->first();
            if ($existing !== null) {
                abort_unless($existing->student_id === $studentId && $existing->actor_id === $request->user()->id, 403);
                if ((int) $existing->branch_id !== (int) $data['branch_id']) {
                    abort_unless($permissions->can('payments.record', (int) $existing->branch_id), 403);
                    abort_unless(DB::connection('tenant')->table('student_branches')
                        ->where('student_id', $studentId)->where('branch_id', $existing->branch_id)->exists(), 404);
                }
                if ($existing->request_hash !== $hash) {
                    throw new HttpResponseException(response()->json([
                        'code' => 'payment_request_changed', 'payment' => $this->payment($existing),
                    ], 409));
                }

                return response()->json(['payment' => $this->payment($existing)]);
            }
            if (! hash_equals($this->accountVersion($studentId, $student->financial_account_revision, $request->user()->id), $data['version'])) {
                $this->conflict('student_account_changed');
            }
            $payment = [
                'id' => (string) Str::uuid(), 'student_id' => $studentId, 'branch_id' => (int) $data['branch_id'],
                'amount' => $data['amount'], 'currency' => $settings->financial_currency,
                'method' => $data['method'], 'received_on' => $data['received_on'],
                'actor_id' => $request->user()->id, 'actor_name' => $request->user()->name,
                'request_id' => $data['request_id'], 'request_hash' => $hash, 'created_at' => now(),
            ];
            DB::connection('tenant')->table('student_payments')->insert($payment);
            DB::connection('tenant')->table('students')->where('id', $studentId)->update([
                'financial_account_revision' => $student->financial_account_revision + 1,
            ]);
            if ($settings->financial_currency_locked_at === null) {
                DB::connection('tenant')->table('center_settings')->where('id', 1)->update([
                    'financial_currency_locked_at' => now(), 'updated_at' => now(),
                ]);
            }
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'branch_id' => $data['branch_id'], 'event' => 'student.payment_recorded',
                'details' => json_encode(['student_id' => $studentId, 'payment_id' => $payment['id'],
                    'amount' => $data['amount'], 'currency' => $settings->financial_currency,
                    'method' => $data['method'], 'received_on' => $data['received_on']]),
                'created_at' => now(),
            ]);

            return response()->json(['payment' => $this->payment((object) $payment)], 201);
        })->header('Cache-Control', 'private, no-store');
    }

    private function scope(CenterPermissions $permissions, string $action): array
    {
        return array_keys(array_filter($permissions->branchRoles,
            fn (array $roles): bool => in_array($action, CenterPermissions::actions($roles), true)));
    }

    private function accountVersion(string $studentId, int $revision, int $actorId): string
    {
        return hash_hmac('sha256', $studentId.':'.$revision.':'.$actorId, config('app.key'));
    }

    private function amount(string|int|float $value): string
    {
        $text = (string) $value;
        abort_unless(preg_match('/^\d{1,10}(?:\.\d{1,2})?$/', $text) === 1, 422, 'أدخل مبلغًا موجبًا حتى منزلتين عشريتين.');
        [$whole, $fraction] = array_pad(explode('.', $text, 2), 2, '');
        $amount = (string) ((int) $whole).'.'.str_pad($fraction, 2, '0');
        abort_unless($amount !== '0.00', 422, 'يجب أن يكون المبلغ أكبر من صفر.');

        return $amount;
    }

    private function payment(object $row): array
    {
        return ['id' => $row->id, 'student_id' => $row->student_id, 'branch_id' => (int) $row->branch_id,
            'amount' => $row->amount, 'currency' => $row->currency, 'method' => $row->method,
            'received_on' => $row->received_on, 'actor_name' => $row->actor_name, 'created_at' => $row->created_at];
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
