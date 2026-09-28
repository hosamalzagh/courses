<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class StudentFinanceTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    private Center $center;

    private User $owner;

    private User $staff;

    private CenterMembership $membership;

    private int $north;

    private int $south;

    private string $base = 'http://alpha.courses.test/api/v1/center';

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')
            ->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha',
                'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
            ])->assertCreated();
        $this->center = Center::where('slug', 'alpha')->firstOrFail();
        $this->owner = User::factory()->create();
        $this->staff = User::factory()->create();
        CenterMembership::create(['tenant_id' => $this->center->id, 'user_id' => $this->owner->id, 'status' => 'active']);
        $this->membership = CenterMembership::create(['tenant_id' => $this->center->id, 'user_id' => $this->staff->id, 'status' => 'active']);
        $this->center->run(fn () => DB::table('center_grants')->insert([
            'user_id' => $this->owner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
        ]));
        $this->asUser($this->owner);
        $this->north = $this->postJson("{$this->base}/branches", ['name' => 'North', 'slug' => 'north'])->assertCreated()->json('branch.id');
        $this->south = $this->postJson("{$this->base}/branches", ['name' => 'South', 'slug' => 'south'])->assertCreated()->json('branch.id');
    }

    public function test_currency_is_chosen_before_first_movement_and_exact_payment_is_append_only_and_idempotent(): void
    {
        $student = $this->student();
        $url = "{$this->base}/students/{$student['id']}";
        $this->postJson("{$url}/payments", $this->payment($student['id'], $this->north))->assertConflict();
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk()
            ->assertJsonPath('revision', 2);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'SAR', 'revision' => 1])->assertConflict();
        $request = $this->payment($student['id'], $this->north, '120.50');
        $saved = $this->postJson("{$url}/payments", $request)->assertCreated()
            ->assertJsonPath('payment.amount', '120.50')->json('payment');
        $this->postJson("{$url}/payments", $request)->assertOk()->assertJsonPath('payment.id', $saved['id']);
        $this->postJson("{$url}/payments", [...$request, 'amount' => '120.51'])->assertConflict()->assertJsonPath('code', 'payment_request_changed');
        $this->postJson("{$url}/payments", [...$this->payment($student['id'], $this->north, '20.00'), 'version' => $request['version']])
            ->assertConflict()->assertJsonPath('code', 'student_account_changed');
        $this->postJson("{$url}/payments", $this->payment($student['id'], $this->north, '20.00'))->assertCreated();
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'SAR', 'revision' => 2])->assertConflict();
        $account = $this->getJson("{$url}/account")->assertOk()->assertJsonPath('account.available_balance', '140.50')
            ->assertJsonPath('account.currency', 'EGP')->assertJsonPath('account.currency_locked', true)
            ->assertJsonCount(2, 'payments');
        $this->assertArrayNotHasKey('revision', $account->json('account'));
        $this->assertNotNull($account->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $account->headers->get('X-Courses-Query-Count'));
        $this->center->run(function () use ($saved): void {
            $this->assertSame(2, DB::table('student_payments')->count());
            foreach (['update', 'delete'] as $kind) {
                try {
                    DB::transaction(fn () => $kind === 'update'
                        ? DB::table('student_payments')->where('id', $saved['id'])->update(['amount' => '1.00'])
                        : DB::table('student_payments')->where('id', $saved['id'])->delete());
                    $this->fail('Approved payments must remain immutable.');
                } catch (QueryException $exception) {
                    $this->assertStringContainsString('Approved student payments are immutable', $exception->getMessage());
                }
            }
            $this->assertSame('120.50', DB::table('student_payments')->where('id', $saved['id'])->value('amount'));
        });
    }

    public function test_staff_only_see_and_record_payments_in_their_authorized_student_branches(): void
    {
        $student = $this->student([$this->north, $this->south]);
        $hidden = $this->student([$this->south]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}";
        $this->postJson("{$url}/payments", $this->payment($student['id'], $this->north, '25.00'))->assertCreated();
        $this->postJson("{$url}/payments", $this->payment($student['id'], $this->south, '80.00'))->assertCreated();
        $this->grant([$this->north => ['accounting']]);
        $this->asUser($this->staff);
        $visible = $this->getJson("{$url}/account")->assertOk()->assertJsonCount(1, 'payments')
            ->assertJsonPath('account.available_balance', '25.00')->assertJsonCount(1, 'recordable_branches');
        $this->assertStringNotContainsString('80.00', $visible->getContent());
        $this->getJson("{$url}/account?q=80")->assertOk()->assertJsonCount(0, 'payments')->assertJsonPath('account.available_balance', '25.00');
        $this->getJson("{$url}/account?q=25")->assertOk()->assertJsonCount(1, 'payments');
        $this->grant([$this->north => ['accounting'], $this->south => ['accounting']]);
        $this->asUser($this->staff);
        $oldSouthRequest = $this->payment($student['id'], $this->south, '60.00');
        $this->postJson("{$url}/payments", $oldSouthRequest)->assertCreated();
        $this->grant([$this->north => ['accounting']]);
        $this->asUser($this->staff);
        $this->postJson("{$url}/payments", [...$oldSouthRequest, 'branch_id' => $this->north])
            ->assertForbidden()->assertDontSee('60.00');
        $this->postJson("{$url}/payments", $oldSouthRequest)->assertForbidden();
        $this->getJson("{$this->base}/students/{$hidden['id']}/account")->assertNotFound();
        $this->postJson("{$url}/payments", $this->payment($student['id'], $this->south, '5.00'))->assertForbidden();
        $this->postJson("{$this->base}/students/{$hidden['id']}/payments", $this->payment($hidden['id'], $this->north, '5.00', $visible->json('account.version')))->assertNotFound();
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'USD', 'revision' => 2])->assertForbidden();
        $this->grant([$this->north => ['branch_auditor']]);
        $this->asUser($this->staff);
        $this->assertStringNotContainsString('student.payment_recorded', $this->getJson("{$this->base}/audit")->assertOk()->getContent());
        $this->assertStringNotContainsString('25.00', $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()->getContent());
        $this->grant([$this->north => ['branch_auditor', 'accounting']]);
        $this->asUser($this->staff);
        $this->assertStringContainsString('student.payment_recorded', $this->getJson("{$this->base}/audit")->assertOk()->getContent());
        $this->assertStringNotContainsString('80.00', $this->getJson("{$this->base}/audit")->getContent());
        $this->grant([]);
        $this->asUser($this->staff);
        $this->getJson("{$url}/account")->assertNotFound();
    }

    public function test_failed_audit_rolls_back_payment_currency_lock_and_account_revision(): void
    {
        $student = $this->student();
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $request = $this->payment($student['id'], $this->north);
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT payment_failure CHECK (event <> 'student.payment_recorded') NOT VALID"));
        try {
            $this->postJson("{$this->base}/students/{$student['id']}/payments", $request)->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT payment_failure'));
        }
        $this->getJson("{$this->base}/students/{$student['id']}/account")->assertOk()
            ->assertJsonPath('account.available_balance', '0')
            ->assertJsonPath('account.currency_locked', false);
        $this->center->run(fn () => $this->assertSame(1, DB::table('students')->where('id', $student['id'])->value('financial_account_revision')));
        $this->postJson("{$this->base}/students/{$student['id']}/payments", $request)->assertCreated();
    }

    public function test_existing_and_new_centers_get_independent_currency_settings(): void
    {
        $student = $this->student();
        $before = $this->center->run(fn () => [
            'student' => DB::table('students')->where('id', $student['id'])->first(['student_number', 'name', 'phone', 'request_id']),
            'branches' => DB::table('student_branches')->where('student_id', $student['id'])->pluck('branch_id')->all(),
            'audit_count' => DB::table('center_audit_logs')->count(),
        ]);
        $this->center->run(function (): void {
            $path = glob(database_path('migrations/tenant/*_create_student_financial_accounts.php'))[0];
            (require $path)->down();
            DB::table('migrations')->where('migration', pathinfo($path, PATHINFO_FILENAME))->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $after = $this->center->run(fn () => [
            'student' => DB::table('students')->where('id', $student['id'])->first(['student_number', 'name', 'phone', 'request_id']),
            'branches' => DB::table('student_branches')->where('student_id', $student['id'])->pluck('branch_id')->all(),
            'audit_count' => DB::table('center_audit_logs')->count(),
        ]);
        $this->assertEquals($before, $after);
        $this->getJson("{$this->base}/students/{$student['id']}/account")->assertOk()->assertJsonPath('account.currency', null);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'SAR', 'revision' => 1])->assertOk();
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Beta', 'slug' => 'beta', 'subdomain' => 'beta', 'plan' => 'starter', 'owner_email' => 'owner@beta.test',
        ])->assertCreated();
        $beta = Center::where('slug', 'beta')->firstOrFail();
        $beta->run(function (): void {
            $this->assertNull(DB::table('center_settings')->where('id', 1)->value('financial_currency'));
        });
    }

    private function student(?array $branches = null): array
    {
        return $this->postJson("{$this->base}/students", [
            'name' => 'Student '.Str::random(8), 'branch_ids' => $branches ?? [$this->north], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('student');
    }

    private function payment(string $studentId, int $branchId, string $amount = '10.00', ?string $version = null): array
    {
        $version ??= $this->getJson("{$this->base}/students/{$studentId}/account")->assertOk()->json('account.version');

        return ['branch_id' => $branchId, 'method' => 'cash', 'received_on' => '2026-09-28',
            'amount' => $amount, 'version' => $version, 'request_id' => (string) Str::uuid()];
    }

    private function grant(array $roles): void
    {
        $this->asUser($this->owner);
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", [
            'center_roles' => [], 'branch_roles' => $roles,
        ])->assertOk();
    }

    private function asUser(User $user): void
    {
        $this->actingAs($user, 'web')->withSession(['center_id' => $this->center->id]);
    }
}
