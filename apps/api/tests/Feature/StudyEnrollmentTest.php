<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class StudyEnrollmentTest extends TestCase
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

    public function test_enrollment_snapshots_price_plan_and_late_join_without_allocating_advance(): void
    {
        $group = $this->group($this->north, '1500.00');
        $student = $this->student([$this->north]);
        $early = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")->json('student.version');
        $this->postJson("{$this->base}/students/{$student['id']}/enrollments", [
            'group_id' => $group['id'], 'group_revision' => $group['revision'], 'currency_revision' => 1, 'joined_on' => '2026-09-28', 'discount' => '0.00',
            'discount_reason' => null, 'version' => $early, 'request_id' => (string) Str::uuid(),
        ])->assertConflict();
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $version = $this->getJson("{$this->base}/students/{$student['id']}/account")->json('account.version');
        $this->postJson("{$this->base}/students/{$student['id']}/payments", [
            'branch_id' => $this->north, 'method' => 'cash', 'received_on' => '2026-09-28',
            'amount' => '500.00', 'version' => $version, 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->grant([$this->north => ['registration', 'fee_discount']]);
        $this->asUser($this->staff);
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $workspace = $this->getJson($url)->assertOk()->assertJsonPath('balance.available_credit', '500.00')
            ->assertJsonPath('balance.debt', '0');
        $this->assertLessThanOrEqual(6, (int) $workspace->headers->get('X-Courses-Query-Count'));
        $payload = ['group_id' => $group['id'], 'group_revision' => $group['revision'], 'currency_revision' => $workspace->json('student.currency_revision'), 'joined_on' => '2026-09-28', 'discount' => '200.00',
            'discount_reason' => 'منحة', 'version' => $workspace->json('student.version'), 'request_id' => (string) Str::uuid()];
        $this->postJson($url, [...$payload, 'discount' => '1600.00', 'request_id' => (string) Str::uuid()])->assertUnprocessable();
        $this->postJson($url, [...$payload, 'discount_reason' => null, 'request_id' => (string) Str::uuid()])->assertUnprocessable();
        $saved = $this->postJson($url, $payload)->assertCreated()->assertJsonPath('attempt.fee.original_price', '1500.00')
            ->assertJsonPath('attempt.fee.discount', '200.00')->assertJsonPath('attempt.fee.net_amount', '1300.00')
            ->json('attempt');
        $this->postJson($url, $payload)->assertOk()->assertJsonPath('attempt.id', $saved['id']);
        $this->getJson($url)->assertOk()->assertJsonPath('balance.available_credit', '500.00')
            ->assertJsonPath('balance.debt', '1300.00')->assertJsonPath('attempts.0.joined_on', '2026-09-28')
            ->assertJsonPath('attempts.0.requirements_count', 1);
        $this->center->run(function () use ($saved): void {
            $this->assertSame(1, DB::table('study_attempts')->count());
            $this->assertSame(1, DB::table('study_attempt_fees')->count());
            $this->assertSame(1, DB::table('study_attempt_group_periods')->where('attempt_id', $saved['id'])->whereNull('left_on')->count());
        });
        $this->asUser($this->owner);
        $account = $this->getJson("{$this->base}/students/{$student['id']}/account")->assertOk()
            ->assertJsonPath('account.debt', '1300.00')->assertJsonPath('account.available_balance', '500.00');
        $this->assertLessThanOrEqual(6, (int) $account->headers->get('X-Courses-Query-Count'));
        $this->patchJson("{$this->base}/groups/{$group['id']}/settings", [
            'revision' => $group['revision'], 'approved_price' => '1700.00',
            'completion_threshold' => null, 'instructor_ids' => array_column($group['instructors'], 'id'),
        ])->assertOk();
        $this->getJson($url)->assertJsonPath('attempts.0.fee.original_price', '1500.00')
            ->assertJsonPath('attempts.0.fee.net_amount', '1300.00');
        $this->grant([$this->north => ['branch_auditor']]);
        $this->asUser($this->staff);
        $this->assertStringNotContainsString('student.enrolled', $this->getJson("{$this->base}/audit")->assertOk()->getContent());
        $this->grant([$this->north => ['branch_auditor', 'registration']]);
        $this->asUser($this->staff);
        $this->assertStringContainsString('student.enrolled', $this->getJson("{$this->base}/audit")->assertOk()->getContent());
    }

    public function test_discount_permission_zero_price_branch_scope_and_stale_enrollment(): void
    {
        $paid = $this->group($this->north, '100.00');
        $free = $this->group($this->south, '0.00');
        $student = $this->student([$this->north, $this->south]);
        $hidden = $this->student([$this->south]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $workspace = $this->getJson($url)->assertOk()->assertJsonCount(1, 'groups');
        $base = ['group_id' => $paid['id'], 'group_revision' => $paid['revision'], 'currency_revision' => $workspace->json('student.currency_revision'), 'joined_on' => '2026-09-28', 'discount' => '0.00', 'discount_reason' => null,
            'version' => $workspace->json('student.version'), 'request_id' => (string) Str::uuid()];
        $this->postJson($url, [...$base, 'discount' => '100.00', 'discount_reason' => 'منحة'])->assertForbidden();
        $this->postJson($url, [...$base, 'discount' => '101.00', 'discount_reason' => 'منحة'])->assertForbidden();
        $this->postJson($url, [...$base, 'discount' => '0.00', 'discount_reason' => null])->assertCreated();
        $this->postJson($url, [...$base, 'request_id' => (string) Str::uuid()])->assertConflict();
        $this->postJson($url, [...$base, 'group_id' => $free['id'], 'request_id' => (string) Str::uuid()])->assertNotFound();
        $this->getJson("{$this->base}/students/{$hidden['id']}/enrollments")->assertNotFound();
        $this->grant([$this->south => ['registration']]);
        $this->asUser($this->staff);
        $fresh = $this->getJson($url)->json('student.version');
        $this->postJson($url, [...$base, 'group_id' => $free['id'], 'group_revision' => $free['revision'], 'version' => $fresh, 'request_id' => (string) Str::uuid()])
            ->assertCreated()->assertJsonPath('attempt.fee.net_amount', '0.00');
        $this->getJson($url)->assertJsonCount(1, 'attempts');
    }

    public function test_full_discount_and_parallel_levels_preserve_immutable_fees_and_currency(): void
    {
        $first = $this->group($this->north, '1500.00');
        $second = $this->group($this->north, '0.00');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $this->grant([$this->north => ['registration', 'fee_discount']]);
        $this->asUser($this->staff);
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $version = $this->getJson($url)->json('student.version');
        $paid = $this->postJson($url, ['group_id' => $first['id'], 'group_revision' => $first['revision'], 'currency_revision' => 2, 'joined_on' => '2026-09-28',
            'discount' => '1500.00', 'discount_reason' => 'منحة كاملة', 'version' => $version,
            'request_id' => (string) Str::uuid()])->assertCreated()->assertJsonPath('attempt.fee.net_amount', '0.00')->json('attempt');
        $this->postJson($url, ['group_id' => $second['id'], 'group_revision' => $second['revision'], 'currency_revision' => 2, 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $this->getJson($url)->json('student.version'),
            'request_id' => (string) Str::uuid()])->assertCreated()->assertJsonPath('attempt.fee.net_amount', '0.00');
        $this->getJson($url)->assertJsonCount(2, 'attempts')->assertJsonPath('balance.debt', '0.00');
        $this->center->run(function () use ($paid): void {
            try {
                DB::table('study_attempt_fees')->where('id', $paid['fee']['id'])->update(['net_amount' => '1.00']);
                $this->fail('Approved fees must be immutable.');
            } catch (QueryException $exception) {
                $this->assertStringContainsString('Approved study attempt fees are immutable', $exception->getMessage());
            }
        });
        $this->asUser($this->owner);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'USD', 'revision' => 2])->assertConflict();
    }

    public function test_audit_failure_rolls_back_attempt_fee_and_currency_lock(): void
    {
        $group = $this->group($this->north, '100.00');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $payload = ['group_id' => $group['id'], 'group_revision' => $group['revision'], 'currency_revision' => 2, 'joined_on' => '2026-09-28', 'discount' => '0.00',
            'discount_reason' => null, 'version' => $this->getJson($url)->json('student.version'),
            'request_id' => (string) Str::uuid()];
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT enrollment_audit_failure CHECK (event <> 'student.enrolled') NOT VALID"));
        try {
            $this->postJson($url, $payload)->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT enrollment_audit_failure'));
        }
        $this->center->run(function () use ($student): void {
            $this->assertSame(0, DB::table('study_attempts')->count());
            $this->assertSame(0, DB::table('study_attempt_fees')->count());
            $this->assertNull(DB::table('center_settings')->where('id', 1)->value('financial_currency_locked_at'));
            $this->assertSame(1, DB::table('students')->where('id', $student['id'])->value('financial_account_revision'));
        });
        $this->postJson($url, $payload)->assertCreated();
    }

    public function test_stale_group_price_must_be_reviewed_before_charging_student(): void
    {
        $group = $this->group($this->north, '100.00');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $preview = $this->getJson($url)->assertOk()->assertJsonPath('groups.0.approved_price', '100.00')->json();
        $payload = ['group_id' => $group['id'], 'group_revision' => $group['revision'], 'currency_revision' => $preview['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $preview['student']['version'],
            'request_id' => (string) Str::uuid()];
        $this->patchJson("{$this->base}/groups/{$group['id']}/settings", [
            'revision' => $group['revision'], 'approved_price' => '200.00',
            'completion_threshold' => null, 'instructor_ids' => array_column($group['instructors'], 'id'),
        ])->assertOk();
        $this->postJson($url, $payload)->assertConflict()->assertJsonPath('code', 'group_changed');
        $this->center->run(fn () => $this->assertSame(0, DB::table('study_attempt_fees')->count()));
        $fresh = $this->getJson($url)->assertOk()->assertJsonPath('groups.0.approved_price', '200.00')->json();
        $this->postJson($url, [...$payload, 'group_revision' => $fresh['groups'][0]['revision'],
            'request_id' => (string) Str::uuid()])->assertCreated()->assertJsonPath('attempt.fee.net_amount', '200.00');
    }

    public function test_stale_currency_must_be_reviewed_before_charging_student(): void
    {
        $group = $this->group($this->north, '1500.00');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $preview = $this->getJson($url)->assertOk()->assertJsonPath('student.currency', 'EGP')->json();
        $payload = ['group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $preview['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $preview['student']['version'],
            'request_id' => (string) Str::uuid()];
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'USD', 'revision' => 2])->assertOk();
        $this->postJson($url, $payload)->assertConflict()->assertJsonPath('code', 'currency_changed');
        $this->center->run(function (): void {
            $this->assertSame(0, DB::table('study_attempts')->count());
            $this->assertSame(0, DB::table('study_attempt_fees')->count());
        });
        $fresh = $this->getJson($url)->assertOk()->assertJsonPath('student.currency', 'USD')->json();
        $this->postJson($url, [...$payload, 'currency_revision' => $fresh['student']['currency_revision'],
            'request_id' => (string) Str::uuid()])->assertCreated()->assertJsonPath('attempt.fee.currency', 'USD');
    }

    private function group(int $branchId, string $price): array
    {
        $course = $this->postJson("{$this->base}/courses", ['branch_id' => $branchId, 'name' => 'Course '.Str::random(5), 'request_id' => (string) Str::uuid()])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", ['name' => 'Stage', 'request_id' => (string) Str::uuid()])->assertCreated()->json('stage');
        $level = $this->postJson("{$this->base}/stages/{$stage['id']}/levels", [
            'name' => 'Level', 'request_id' => (string) Str::uuid(), 'lectures' => [['number' => 1, 'content' => 'Required', 'planned_hours' => 2]],
        ])->assertCreated()->json('level');
        $instructor = $this->postJson("{$this->base}/instructors", [
            'name' => 'Teacher '.Str::random(5), 'branch_ids' => [$branchId], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('instructor');

        return $this->postJson("{$this->base}/groups", [
            'level_id' => $level['id'], 'plan_version_id' => $level['plan']['id'], 'name' => 'Group',
            'approved_price' => $price, 'instructor_ids' => [$instructor['id']], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
    }

    private function student(array $branches): array
    {
        return $this->postJson("{$this->base}/students", [
            'name' => 'Student '.Str::random(8), 'branch_ids' => $branches, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('student');
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
