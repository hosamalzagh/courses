<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use App\Support\ActiveStudentAllocations;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
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

    public function test_existing_attempt_threshold_changes_only_after_selected_preview_and_approval(): void
    {
        $group = $this->group($this->north, '0.00', 10);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $attempts = [];
        foreach (range(1, 2) as $number) {
            $student = $this->student([$this->north]);
            $url = "{$this->base}/students/{$student['id']}/enrollments";
            $workspace = $this->getJson($url)->assertOk()->json();
            $attempts[] = $this->postJson($url, [
                'group_id' => $group['id'], 'group_revision' => $group['revision'],
                'currency_revision' => $workspace['student']['currency_revision'],
                'joined_on' => now('Africa/Cairo')->toDateString(), 'discount' => '0.00',
                'discount_reason' => null, 'version' => $workspace['student']['version'],
                'request_id' => (string) Str::uuid(),
            ])->assertCreated()->json('attempt');
        }
        $updatedGroup = $this->patchJson("{$this->base}/groups/{$group['id']}/settings", [
            'revision' => $group['revision'], 'approved_price' => '0.00',
            'completion_threshold' => 60, 'instructor_ids' => array_column($group['instructors'], 'id'),
        ])->assertOk()->json('group');
        $inactiveChange = ['attempt_ids' => [$attempts[1]['id']], 'reason' => 'اختبار ثبات قاعدة المحاولة المنتهية'];
        $inactivePath = "{$this->base}/groups/{$group['id']}/completion-threshold";
        $inactivePreview = $this->postJson("{$inactivePath}/preview", $inactiveChange)->assertOk()->json();
        foreach (['withdrawn', 'completed'] as $status) {
            $this->center->run(fn () => DB::table('study_attempts')->where('id', $attempts[1]['id'])
                ->update(['status' => $status, 'revision' => DB::raw('revision + 1')]));
            $this->postJson("{$inactivePath}/preview", $inactiveChange)->assertNotFound();
            $this->postJson($inactivePath, [...$inactiveChange,
                'preview_token' => $inactivePreview['preview_token'], 'request_id' => (string) Str::uuid(),
            ])->assertNotFound();
            $this->center->run(fn () => DB::table('study_attempts')->where('id', $attempts[1]['id'])
                ->update(['status' => 'active', 'revision' => DB::raw('revision + 1')]));
        }
        $this->center->run(function () use ($group, $attempts): void {
            $lectures = DB::table('plan_lectures')->where('plan_version_id', $group['plan_version_id'])
                ->orderBy('number')->limit(6)->get(['id', 'number']);
            foreach ($lectures as $lecture) {
                $sessionId = (string) Str::uuid();
                DB::table('study_sessions')->insert(['id' => $sessionId, 'group_id' => $group['id'],
                    'plan_lecture_id' => $lecture->id, 'number' => $lecture->number,
                    'scheduled_at' => now()->addHours((int) $lecture->number), 'status' => 'planned', 'created_by' => $this->owner->id,
                    'created_by_name' => $this->owner->name, 'created_at' => now(), 'updated_at' => now()]);
                DB::table('study_attendance_entries')->insert(['id' => (string) Str::uuid(),
                    'session_id' => $sessionId, 'attempt_id' => $attempts[0]['id'], 'status' => 'counted',
                    'recorded_by' => $this->owner->id, 'recorded_at' => now(), 'created_at' => now(), 'updated_at' => now()]);
            }
        });
        $path = "{$this->base}/groups/{$group['id']}/completion-threshold";
        $change = ['attempt_ids' => [$attempts[0]['id']], 'reason' => 'تطبيق الحد الجديد على المحاولة المختارة'];
        $preview = $this->postJson("{$path}/preview", $change)->assertOk()
            ->assertJsonPath('students.0.before_threshold', 80)
            ->assertJsonPath('students.0.after_threshold', 60)
            ->assertJsonPath('students.0.before_needed', 8)
            ->assertJsonPath('students.0.after_needed', 6)
            ->assertJsonPath('students.0.open_credited_count', 6)
            ->assertJsonPath('students.0.before_eligible', false)
            ->assertJsonPath('students.0.after_eligible', true)
            ->assertJsonPath('students.0.after_provisional', true)->json();
        $confirmation = [...$change, 'preview_token' => $preview['preview_token'],
            'request_id' => (string) Str::uuid()];
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->postJson("{$path}/preview", $change)->assertForbidden();
        $this->postJson($path, $confirmation)->assertForbidden();
        $this->asUser($this->owner);
        $this->patchJson("{$this->base}/groups/{$group['id']}/settings", [
            'revision' => $updatedGroup['revision'], 'approved_price' => '1.00',
            'completion_threshold' => 60, 'instructor_ids' => array_column($group['instructors'], 'id'),
        ])->assertOk();
        $this->postJson($path, $confirmation)->assertConflict();
        $preview = $this->postJson("{$path}/preview", $change)->assertOk()->json();
        $confirmation = [...$change, 'preview_token' => $preview['preview_token'],
            'request_id' => (string) Str::uuid()];
        $this->postJson($path, $confirmation)->assertOk()->assertJsonPath('students.0.after_threshold', 60);
        $this->postJson($path, $confirmation)->assertOk();
        $this->center->run(function () use ($attempts): void {
            $this->assertSame(60, DB::table('study_attempts')->where('id', $attempts[0]['id'])->value('completion_threshold'));
            $this->assertSame(80, DB::table('study_attempts')->where('id', $attempts[1]['id'])->value('completion_threshold'));
            $this->assertSame(1, DB::table('study_attempt_threshold_history')->count());
            $this->assertSame(6, DB::table('study_attempt_threshold_history')->value('open_credited_count'));
            $this->assertTrue(DB::table('study_attempt_threshold_history')->value('after_provisional'));
            try {
                (require database_path('migrations/tenant/2026_09_29_045000_create_attempt_threshold_decisions.php'))->down();
                $this->fail('Rollback must preserve recorded threshold decisions.');
            } catch (\RuntimeException $exception) {
                $this->assertStringContainsString('Cannot roll back', $exception->getMessage());
            }
        });
        $this->grant([$this->north => ['academic_admin', 'branch_auditor']]);
        $this->asUser($this->staff);
        $this->assertStringContainsString('study_attempts.completion_threshold_applied',
            $this->getJson("{$this->base}/audit")->assertOk()->getContent());
        $this->grant([$this->north => ['registration', 'branch_auditor']]);
        $this->asUser($this->staff);
        $this->assertStringNotContainsString('study_attempts.completion_threshold_applied',
            $this->getJson("{$this->base}/audit")->assertOk()->getContent());
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
            ->assertJsonPath('balance.debt', '0.00');
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

    public function test_level_waitlist_and_reattachment_keep_attempt_fee_and_group_history(): void
    {
        $first = $this->group($this->north, '150.00');
        $second = $this->postJson("{$this->base}/groups", [
            'level_id' => $first['level_id'], 'plan_version_id' => $first['plan_version_id'],
            'name' => 'Second Group', 'approved_price' => '200.00',
            'instructor_ids' => array_column($first['instructors'], 'id'), 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $other = $this->group($this->south, '0.00');
        $student = $this->student([$this->north, $this->south]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $workspace = $this->getJson($url)->assertOk()->json();
        $saved = $this->postJson($url, [
            'group_id' => $first['id'], 'group_revision' => $first['revision'],
            'currency_revision' => $workspace['student']['currency_revision'], 'joined_on' => '2026-09-27',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $workspace['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $this->center->run(function () use ($first, $saved): void {
            $lecture = DB::table('plan_lectures')->where('plan_version_id', $first['plan_version_id'])->firstOrFail();
            $sessionId = (string) Str::uuid();
            DB::table('study_sessions')->insert(['id' => $sessionId, 'group_id' => $first['id'],
                'plan_lecture_id' => $lecture->id, 'number' => $lecture->number,
                'scheduled_at' => '2026-09-27 08:00:00+00', 'status' => 'held', 'revision' => 2,
                'created_by' => $this->owner->id, 'created_by_name' => $this->owner->name,
                'closed_at' => now(), 'closed_by' => $this->owner->id, 'created_at' => now(), 'updated_at' => now()]);
            DB::table('study_attendance_entries')->insert(['id' => (string) Str::uuid(), 'session_id' => $sessionId,
                'attempt_id' => $saved['id'], 'status' => 'counted', 'revision' => 1,
                'recorded_by' => $this->owner->id, 'recorded_at' => now(), 'created_at' => now(), 'updated_at' => now()]);
        });
        $this->getJson("{$this->base}/groups/{$first['id']}/coverage")
            ->assertOk()->assertJsonPath('students.0.covered_count', 1);
        $waitUrl = "{$url}/{$saved['id']}/waitlist";
        $enter = ['entered_on' => '2026-09-28', 'reason' => 'بانتظار موعد مناسب',
            'revision' => $saved['revision'], 'request_id' => (string) Str::uuid()];
        $this->postJson($waitUrl, [...$enter, 'entered_on' => '2026-09-26', 'request_id' => (string) Str::uuid()])->assertUnprocessable();
        $waiting = $this->postJson($waitUrl, $enter)->assertCreated()->assertJsonPath('waitlist.reason', $enter['reason'])->json('waitlist');
        $this->postJson($waitUrl, $enter)->assertOk()->assertJsonPath('waitlist.id', $waiting['id']);
        $this->postJson($waitUrl, [...$enter, 'request_id' => (string) Str::uuid()])->assertConflict();
        $current = $this->getJson($url)->assertOk()->assertJsonPath('attempts.0.id', $saved['id'])
            ->assertJsonPath('attempts.0.current_group_id', null)->assertJsonPath('attempts.0.latest_waitlist.reason', $enter['reason'])
            ->assertJsonPath('balance.debt', '150.00');
        $this->assertLessThanOrEqual(6, (int) $current->headers->get('X-Courses-Query-Count'));
        $choices = $this->getJson($waitUrl)->assertOk()->assertJsonCount(2, 'groups')
            ->assertJsonCount(1, 'history')->assertJsonPath('history.0.id', $waiting['id']);
        $this->assertLessThanOrEqual(6, (int) $choices->headers->get('X-Courses-Query-Count'));
        $this->grant([$this->north => ['branch_auditor']]);
        $this->asUser($this->staff);
        $this->getJson($waitUrl)->assertNotFound();
        $this->postJson($waitUrl, [...$enter, 'request_id' => (string) Str::uuid()])->assertNotFound();
        $this->assertStringNotContainsString('student.study_waitlisted', $this->getJson("{$this->base}/audit")->assertOk()->getContent());
        $this->assertStringNotContainsString('student.study_waitlisted', $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()->getContent());
        $this->grant([$this->north => ['registration', 'branch_auditor']]);
        $this->asUser($this->staff);
        $this->assertStringContainsString('student.study_waitlisted', $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()->getContent());
        $rejoin = ['group_id' => $second['id'], 'group_revision' => $second['revision'],
            'joined_on' => '2026-09-28', 'revision' => $choices->json('attempt_revision'),
            'request_id' => (string) Str::uuid()];
        $this->postJson("{$url}/{$saved['id']}/reattach", [...$rejoin, 'group_id' => $other['id'],
            'request_id' => (string) Str::uuid()])->assertNotFound();
        $this->postJson("{$url}/{$saved['id']}/reattach", [...$rejoin, 'revision' => $saved['revision'],
            'request_id' => (string) Str::uuid()])->assertConflict();
        $this->postJson("{$url}/{$saved['id']}/reattach", $rejoin)->assertCreated()
            ->assertJsonPath('waitlist.to_group_id', $second['id']);
        $this->postJson("{$url}/{$saved['id']}/reattach", $rejoin)->assertOk();
        $this->getJson($url)->assertOk()->assertJsonPath('attempts.0.id', $saved['id'])
            ->assertJsonPath('attempts.0.current_group_id', $second['id'])
            ->assertJsonPath('attempts.0.latest_waitlist.left_on', '2026-09-28')
            ->assertJsonPath('attempts.0.fee.net_amount', '150.00');
        $this->getJson("{$this->base}/groups/{$first['id']}/coverage")->assertOk()->assertJsonCount(0, 'students');
        $coverage = $this->getJson("{$this->base}/groups/{$second['id']}/coverage")
            ->assertOk()->assertJsonPath('students.0.attempt_id', $saved['id'])
            ->assertJsonPath('students.0.covered_count', 1);
        $this->assertLessThanOrEqual(6, (int) $coverage->headers->get('X-Courses-Query-Count'));
        $this->center->run(function () use ($saved, $first, $second): void {
            $this->assertSame(1, DB::table('study_attempts')->count());
            $this->assertSame(1, DB::table('study_attempt_fees')->count());
            $periods = DB::table('study_attempt_group_periods')->where('attempt_id', $saved['id'])
                ->orderBy('joined_on')->orderBy('created_at')->get();
            $this->assertCount(2, $periods);
            $this->assertSame($first['id'], $periods[0]->group_id);
            $this->assertSame('2026-09-28', $periods[0]->left_on);
            $this->assertSame($second['id'], $periods[1]->group_id);
            $this->assertNull($periods[1]->left_on);
        });
        $this->center->run(fn () => DB::table('study_attendance_entries')->where('attempt_id', $saved['id'])
            ->update(['status' => 'absent']));
        $this->asUser($this->owner);
        $absences = $this->getJson("{$this->base}/absence-review?view=all")->assertOk()
            ->assertJsonPath('students.0.id', $saved['id'])
            ->assertJsonPath('students.0.total_absences', 0)
            ->assertJsonPath('students.0.historical_absences', 1);
        $this->assertLessThanOrEqual(6, (int) $absences->headers->get('X-Courses-Query-Count'));
        $this->asUser($this->staff);
        $revision = $this->getJson($url)->json('attempts.0.revision');
        $this->postJson($waitUrl, ['entered_on' => '2026-09-28', 'reason' => 'تعذر الاستمرار',
            'revision' => $revision, 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->asUser($this->owner);
        $this->getJson("{$this->base}/absence-review?view=all")->assertOk()->assertJsonCount(0, 'students');
        $this->asUser($this->staff);
        $revision = $this->getJson($url)->json('attempts.0.revision');
        $this->travelTo(now('Africa/Cairo')->addDay()->setTime(12, 0));
        $this->postJson("{$url}/{$saved['id']}/withdraw", ['withdrawn_on' => '2026-09-29',
            'reason' => 'انسحاب أثناء الانتظار', 'revision' => $revision,
            'request_id' => (string) Str::uuid()])->assertOk();
        $afterWithdrawal = $this->getJson($url)->assertOk()->assertJsonPath('attempts.0.status', 'withdrawn')
            ->assertJsonPath('attempts.0.latest_waitlist.left_on', '2026-09-29')->json();
        $this->center->run(fn () => $this->assertSame(1, DB::table('study_attempt_fees')->count()));
        $repeatGroup = collect($afterWithdrawal['groups'])->firstWhere('id', $second['id']);
        $repeat = ['group_id' => $second['id'], 'group_revision' => $repeatGroup['revision'],
            'currency_revision' => $afterWithdrawal['student']['currency_revision'],
            'joined_on' => '2026-09-28', 'discount' => '0.00', 'discount_reason' => null,
            'repeated_from_attempt_id' => $saved['id'], 'version' => $afterWithdrawal['student']['version'],
            'request_id' => (string) Str::uuid()];
        $this->postJson($url, $repeat)->assertUnprocessable();
        $this->postJson($url, [...$repeat, 'joined_on' => '2026-09-29',
            'request_id' => (string) Str::uuid()])->assertCreated();
        $this->center->run(fn () => $this->assertSame(2, DB::table('study_attempt_fees')->count()));
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

    public function test_suspension_blocks_stale_enrollment_without_fee_and_lifting_restores_registration(): void
    {
        $priorGroup = $this->group($this->north, '80.00');
        $group = $this->group($this->north, '150.00');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $initial = $this->getJson($url)->assertOk()->json();
        $prior = $this->postJson($url, ['group_id' => $priorGroup['id'], 'group_revision' => $priorGroup['revision'],
            'currency_revision' => $initial['student']['currency_revision'], 'joined_on' => '2026-09-27',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $initial['student']['version'],
            'request_id' => (string) Str::uuid()])->assertCreated()->json('attempt');
        $preview = $this->getJson($url)->assertOk()->assertJsonPath('student.status', 'active')->json();
        $payload = ['group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $preview['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $preview['student']['version'],
            'request_id' => (string) Str::uuid()];
        $statusUrl = "{$this->base}/students/{$student['id']}/status";
        $this->postJson($statusUrl, ['status' => 'suspended', 'reason' => 'وقف مؤقت',
            'status_revision' => 1, 'request_id' => (string) Str::uuid()])->assertOk();
        $this->postJson($url, $payload)->assertConflict()->assertJsonPath('code', 'student_suspended');
        $this->getJson($url)->assertOk()->assertJsonPath('student.status', 'suspended')->assertJsonCount(1, 'attempts')
            ->assertJsonPath('attempts.0.fee.net_amount', '80.00');
        $this->center->run(function () use ($student, $prior): void {
            $this->assertSame(1, DB::table('study_attempts')->where('student_id', $student['id'])->count());
            $this->assertSame(1, DB::table('study_attempt_fees')->where('student_id', $student['id'])->count());
            $this->assertSame('80.00', DB::table('study_attempt_fees')->where('id', $prior['fee']['id'])->value('net_amount'));
            $this->assertSame(1, DB::table('center_audit_logs')->where('event', 'student.enrolled')->count());
        });
        $this->postJson($statusUrl, ['status' => 'active', 'reason' => 'انتهى الإيقاف',
            'status_revision' => 2, 'request_id' => (string) Str::uuid()])->assertOk();
        $fresh = $this->getJson($url)->assertOk()->assertJsonPath('student.status', 'active')->json();
        $this->postJson($url, [...$payload, 'version' => $fresh['student']['version'],
            'request_id' => (string) Str::uuid()])->assertCreated()->assertJsonPath('attempt.fee.net_amount', '150.00');
        $attempts = $this->getJson($url)->assertOk()->assertJsonCount(2, 'attempts')->json('attempts');
        $this->assertSame('80.00', collect($attempts)->firstWhere('id', $prior['id'])['fee']['net_amount']);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonCount(1, 'suspensions')
            ->assertJsonPath('suspensions.0.suspended_reason', 'وقف مؤقت')->assertJsonPath('suspensions.0.lifted_reason', 'انتهى الإيقاف');
    }

    public function test_enrollment_note_keeps_versions_importance_and_event_permissions_without_changing_fee(): void
    {
        $group = $this->group($this->north, '150.00');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $workspaceUrl = "{$this->base}/students/{$student['id']}/enrollments";
        $preview = $this->getJson($workspaceUrl)->assertOk()->json();
        $attempt = $this->postJson($workspaceUrl, ['group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $preview['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $preview['student']['version'],
            'request_id' => (string) Str::uuid()])->assertCreated()->json('attempt');
        $url = "{$workspaceUrl}/{$attempt['id']}/note";
        $this->getJson($url)->assertOk()->assertJsonPath('note', null)->assertJsonCount(0, 'versions');
        $requestId = (string) Str::uuid();
        $creation = ['body' => 'اتفقنا على مراجعة الموعد', 'important' => false, 'revision' => 0, 'request_id' => $requestId];
        $note = $this->putJson($url, $creation)->assertCreated()->assertJsonPath('note.revision', 1)->json('note');
        $this->putJson($url, $creation)->assertOk()->assertJsonPath('note.id', $note['id']);
        $this->putJson($url, [...$creation, 'body' => 'نص آخر'])->assertConflict()->assertJsonPath('code', 'note_request_changed');
        $this->putJson($url, [...$creation, 'request_id' => (string) Str::uuid()])->assertConflict()->assertJsonPath('code', 'note_changed');
        $this->putJson($url, ['body' => 'موعد جديد بموافقة الطالب', 'important' => true,
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertOk()->assertJsonPath('note.revision', 2)
            ->assertJsonPath('note.important', true);
        $important = $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()
            ->assertJsonCount(1, 'important_notes')->assertJsonPath('important_notes.0.id', $note['id']);
        $this->assertLessThanOrEqual(6, (int) $important->headers->get('X-Courses-Query-Count'));
        $linked = $this->getJson("{$workspaceUrl}?attempt_id={$attempt['id']}")->assertOk()
            ->assertJsonCount(1, 'attempts')->assertJsonPath('attempts.0.id', $attempt['id']);
        $this->assertLessThanOrEqual(6, (int) $linked->headers->get('X-Courses-Query-Count'));
        $this->putJson($url, ['body' => 'موعد جديد بموافقة الطالب', 'important' => false,
            'revision' => 2, 'request_id' => (string) Str::uuid()])->assertOk()->assertJsonPath('note.revision', 3)
            ->assertJsonPath('note.important', false);
        $unifiedUrl = "{$this->base}/students/{$student['id']}/notes";
        $unified = $this->getJson($unifiedUrl)->assertOk()->assertJsonCount(1, 'entries')
            ->assertJsonPath('entries.0.id', $note['id'])->assertJsonPath('entries.0.important', false);
        $this->assertLessThanOrEqual(6, (int) $unified->headers->get('X-Courses-Query-Count'));
        $unifiedHistory = $this->getJson("{$unifiedUrl}/{$note['id']}")->assertOk()
            ->assertJsonCount(3, 'versions')->assertJsonPath('versions.1.important', true);
        $this->assertLessThanOrEqual(6, (int) $unifiedHistory->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$this->base}/students/{$student['id']}?tab=notes")->assertOk()
            ->assertJsonCount(0, 'important_notes')->assertJsonCount(1, 'student_notes.entries');
        $this->getJson("{$this->base}/student-workspace?tab=notes")->assertOk()->assertJsonMissingPath('student_notes');
        $history = $this->getJson($url)->assertOk()->assertJsonCount(3, 'versions')
            ->assertJsonPath('versions.0.important', false)->assertJsonPath('versions.1.important', true)
            ->assertJsonPath('versions.2.body', 'اتفقنا على مراجعة الموعد');
        $this->assertNotNull($history->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $history->headers->get('X-Courses-Query-Count'));
        $notesUrl = "{$this->base}/students/{$student['id']}/enrollment-notes";
        $notes = $this->getJson($notesUrl)->assertOk()->assertJsonCount(1, 'entries')
            ->assertJsonPath('entries.0.attempt_id', $attempt['id'])
            ->assertJsonPath('entries.0.body', 'موعد جديد بموافقة الطالب');
        $this->assertNotNull($notes->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $notes->headers->get('X-Courses-Query-Count'));
        $profileNotes = $this->getJson("{$this->base}/students/{$student['id']}?tab=enrollment-notes")
            ->assertOk()->assertJsonCount(1, 'enrollment_notes.entries')
            ->assertJsonPath('enrollment_notes.entries.0.body', 'موعد جديد بموافقة الطالب');
        $this->assertNotNull($profileNotes->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $profileNotes->headers->get('X-Courses-Query-Count'));
        $this->getJson($workspaceUrl)->assertOk()->assertJsonPath('attempts.0.note.revision', 3)
            ->assertJsonPath('attempts.0.note.important', false)
            ->assertJsonPath('attempts.0.fee.net_amount', '150.00')->assertJsonPath('attempts.0.status', 'active');
        $this->center->run(function () use ($note): void {
            $this->assertSame(1, DB::table('student_event_notes')->count());
            $this->assertSame(3, DB::table('student_event_note_revisions')->where('note_id', $note['id'])->count());
            $this->assertSame(1, DB::table('study_attempt_fees')->count());
            $this->assertStringNotContainsString('اتفقنا', DB::table('center_audit_logs')->where('event', 'student.study_attempt_note_created')->value('details'));
        });
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->getJson($url)->assertOk()->assertJsonCount(3, 'versions');
        $this->getJson($notesUrl)->assertOk()->assertJsonCount(1, 'entries');
        $this->getJson($unifiedUrl)->assertOk()->assertJsonCount(1, 'entries');
        $this->getJson("{$unifiedUrl}/{$note['id']}")->assertOk()->assertJsonCount(3, 'versions');
        $this->getJson("{$this->base}/students/{$student['id']}?tab=enrollment-notes")
            ->assertOk()->assertJsonCount(1, 'enrollment_notes.entries');
        $this->getJson($workspaceUrl)->assertNotFound();
        $this->putJson($url, ['body' => 'تعديل غير مخول', 'important' => true, 'revision' => 3,
            'request_id' => (string) Str::uuid()])->assertNotFound();
        $this->grant([$this->south => ['registration']]);
        $this->asUser($this->staff);
        $this->getJson($url)->assertNotFound();
        $this->getJson($notesUrl)->assertNotFound();
        $this->getJson($unifiedUrl)->assertNotFound();
        $this->getJson("{$unifiedUrl}/{$note['id']}")->assertNotFound();
        $this->putJson($url, ['body' => 'تعديل فرع آخر', 'important' => true, 'revision' => 3,
            'request_id' => (string) Str::uuid()])->assertNotFound();
        $this->grant([$this->north => ['branch_auditor']]);
        $this->asUser($this->staff);
        $this->assertStringNotContainsString('student.study_attempt_note_', $this->getJson("{$this->base}/audit")->assertOk()->getContent());
        $this->grant([$this->north => ['branch_auditor', 'registration']]);
        $this->asUser($this->staff);
        $this->assertStringContainsString('student.study_attempt_note_created', $this->getJson("{$this->base}/audit")->assertOk()->getContent());
    }

    public function test_enrollment_note_audit_failure_rolls_back_and_versions_cannot_be_rewritten(): void
    {
        $group = $this->group($this->north, '30.00');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $workspaceUrl = "{$this->base}/students/{$student['id']}/enrollments";
        $preview = $this->getJson($workspaceUrl)->json();
        $attempt = $this->postJson($workspaceUrl, ['group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $preview['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $preview['student']['version'],
            'request_id' => (string) Str::uuid()])->assertCreated()->json('attempt');
        $url = "{$workspaceUrl}/{$attempt['id']}/note";
        $payload = ['body' => 'متابعة بعد التسجيل', 'important' => true, 'revision' => 0,
            'request_id' => (string) Str::uuid()];
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT note_audit_failure CHECK (event <> 'student.study_attempt_note_created') NOT VALID"));
        try {
            $this->putJson($url, $payload)->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT note_audit_failure'));
        }
        $this->center->run(function (): void {
            $this->assertSame(0, DB::table('student_event_notes')->count());
            $this->assertSame(0, DB::table('student_event_note_revisions')->count());
        });
        $note = $this->putJson($url, $payload)->assertCreated()->json('note');
        $this->center->run(function () use ($note): void {
            try {
                DB::table('student_event_note_revisions')->where('note_id', $note['id'])->update(['body' => 'محو التاريخ']);
                $this->fail('Note revisions must be immutable.');
            } catch (QueryException $exception) {
                $this->assertStringContainsString('Student event note revisions are immutable', $exception->getMessage());
            }
        });
    }

    public function test_payment_can_be_split_reversed_and_reallocated_without_mutating_approved_entries(): void
    {
        $first = $this->group($this->north, '100.00');
        $second = $this->group($this->north, '100.00');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        foreach ([$first, $second] as $group) {
            $workspace = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")->assertOk()->json();
            $this->postJson("{$this->base}/students/{$student['id']}/enrollments", [
                'group_id' => $group['id'], 'group_revision' => $group['revision'],
                'currency_revision' => $workspace['student']['currency_revision'], 'joined_on' => '2026-09-28',
                'discount' => '0.00', 'discount_reason' => null, 'version' => $workspace['student']['version'],
                'request_id' => (string) Str::uuid(),
            ])->assertCreated();
        }
        $accountUrl = "{$this->base}/students/{$student['id']}/account";
        $payment = $this->postJson("{$this->base}/students/{$student['id']}/payments", [
            'branch_id' => $this->north, 'method' => 'cash', 'received_on' => '2026-09-28',
            'amount' => '150.00', 'version' => $this->getJson($accountUrl)->json('account.version'),
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('payment');
        $url = "{$this->base}/students/{$student['id']}/payments/{$payment['id']}";
        $options = $this->getJson("{$url}/allocation-options")->assertOk()->assertJsonCount(2, 'fees');
        $this->assertLessThanOrEqual(6, (int) $options->headers->get('X-Courses-Query-Count'));
        $targets = [['attempt_id' => $options->json('fees.0.attempt_id'), 'amount' => '90.00'],
            ['attempt_id' => $options->json('fees.1.attempt_id'), 'amount' => '60.00']];
        $request = ['targets' => $targets, 'version' => $options->json('version'), 'request_id' => (string) Str::uuid()];
        foreach (['+5', '.5'] as $invalidAmount) {
            $this->postJson("{$url}/allocations", [...$request, 'targets' => [[
                'attempt_id' => $targets[0]['attempt_id'], 'amount' => $invalidAmount,
            ]]])->assertUnprocessable()->assertJsonValidationErrors('targets.0.amount');
        }
        $this->postJson("{$url}/allocations", [...$request, 'targets' => [['attempt_id' => $targets[0]['attempt_id'], 'amount' => '151.00']]])
            ->assertConflict()->assertJsonPath('code', 'payment_not_available');
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT allocation_audit_failure CHECK (event <> 'student.payment_allocated') NOT VALID"));
        try {
            $this->postJson("{$url}/allocations", $request)->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT allocation_audit_failure'));
        }
        $this->center->run(fn () => $this->assertSame(0, DB::table('student_payment_allocations')->count()));
        $this->getJson($accountUrl)->assertJsonPath('account.available_balance', '150.00');
        $saved = $this->postJson("{$url}/allocations", $request)->assertCreated()->assertJsonCount(2, 'allocations')->json('allocations');
        $this->postJson("{$url}/allocations", $request)->assertOk()->assertJsonCount(2, 'allocations');
        $this->postJson("{$url}/allocations", [...$request, 'targets' => [['attempt_id' => $targets[0]['attempt_id'], 'amount' => '90.01']]])
            ->assertConflict()->assertJsonPath('code', 'allocation_request_changed');
        $this->getJson($accountUrl)->assertOk()->assertJsonPath('account.received_total', '150.00')
            ->assertJsonPath('account.due_total', '200.00')->assertJsonPath('account.paid_total', '150.00')
            ->assertJsonPath('account.available_balance', '0.00')->assertJsonPath('account.debt', '50.00')
            ->assertJsonPath('payments.0.available_amount', '0.00');
        $this->getJson("{$this->base}/students/{$student['id']}/enrollments")->assertOk()
            ->assertJsonPath('balance.available_credit', '0.00')->assertJsonPath('balance.debt', '50.00');
        $this->postJson("{$url}/allocations", ['targets' => [['attempt_id' => $targets[0]['attempt_id'], 'amount' => '1.00']],
            'version' => $this->getJson($accountUrl)->json('account.version'), 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'payment_not_available');
        $reverseUrl = "{$this->base}/students/{$student['id']}/allocations/{$saved[1]['id']}/reverse";
        $reversal = ['reason' => 'تخصيص للمجموعة الخطأ', 'version' => $this->getJson($accountUrl)->json('account.version'),
            'request_id' => (string) Str::uuid()];
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT reversal_audit_failure CHECK (event <> 'student.payment_allocation_reversed') NOT VALID"));
        try {
            $this->postJson($reverseUrl, $reversal)->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT reversal_audit_failure'));
        }
        $this->center->run(fn () => $this->assertSame(0, DB::table('student_payment_allocation_reversals')->count()));
        $this->getJson($accountUrl)->assertJsonPath('account.available_balance', '0.00');
        $this->postJson($reverseUrl, $reversal)->assertCreated();
        $this->postJson($reverseUrl, $reversal)->assertOk();
        $this->postJson($reverseUrl, [...$reversal, 'request_id' => (string) Str::uuid(),
            'version' => $this->getJson($accountUrl)->json('account.version')])->assertConflict()
            ->assertJsonPath('code', 'allocation_already_reversed');
        $this->getJson($accountUrl)->assertOk()->assertJsonPath('account.available_balance', '60.00')
            ->assertJsonPath('account.paid_total', '90.00')->assertJsonPath('account.debt', '110.00');
        $fresh = $this->getJson("{$url}/allocation-options")->assertOk();
        $this->postJson("{$url}/allocations", ['targets' => [['attempt_id' => $targets[1]['attempt_id'], 'amount' => '50.00']],
            'version' => $fresh->json('version'), 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->getJson($accountUrl)->assertOk()->assertJsonPath('account.available_balance', '10.00')
            ->assertJsonPath('account.paid_total', '140.00')->assertJsonPath('account.debt', '60.00');
        $this->center->run(function () use ($saved): void {
            $this->assertSame(3, DB::table('student_payment_allocations')->count());
            $this->assertSame(1, DB::table('student_payment_allocation_reversals')->count());
            $allocationAudit = json_decode(DB::table('center_audit_logs')->where('event', 'student.payment_allocated')
                ->orderBy('id')->value('details'), true);
            $this->assertSame('150.00', $allocationAudit['payment_available_before']);
            $this->assertSame('0.00', $allocationAudit['payment_available_after']);
            $reversalAudit = json_decode(DB::table('center_audit_logs')->where('event', 'student.payment_allocation_reversed')
                ->value('details'), true);
            $this->assertSame('0.00', $reversalAudit['payment_available_before']);
            $this->assertSame('60.00', $reversalAudit['payment_available_after']);
            $this->assertSame('تخصيص للمجموعة الخطأ', $reversalAudit['reason']);
            foreach (['update', 'delete'] as $kind) {
                try {
                    DB::transaction(fn () => $kind === 'update'
                        ? DB::table('student_payment_allocations')->where('id', $saved[0]['id'])->update(['amount' => '1.00'])
                        : DB::table('student_payment_allocations')->where('id', $saved[0]['id'])->delete());
                    $this->fail('Approved allocations must remain immutable.');
                } catch (QueryException $exception) {
                    $this->assertStringContainsString('Approved student allocation entries are immutable', $exception->getMessage());
                }
            }
            $this->assertSame(3, DB::table('student_payment_allocations')->count());
        });
        $this->grant([$this->north => ['branch_auditor']]);
        $this->asUser($this->staff);
        $branchAudit = $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()->getContent();
        $this->assertStringNotContainsString('student.payment_allocated', $branchAudit);
        $this->assertStringNotContainsString('student.payment_allocation_reversed', $branchAudit);
        $this->assertStringNotContainsString('تخصيص للمجموعة الخطأ', $branchAudit);
        $this->grant([$this->north => ['branch_auditor', 'accounting']]);
        $this->asUser($this->staff);
        $visibleAudit = $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()->getContent();
        $this->assertStringContainsString('student.payment_allocated', $visibleAudit);
        $this->assertStringContainsString('student.payment_allocation_reversed', $visibleAudit);
    }

    public function test_cross_branch_allocation_requires_both_branch_authorities_and_hides_private_fees(): void
    {
        $northGroup = $this->group($this->north, '40.00');
        $southGroup = $this->group($this->south, '40.00');
        $student = $this->student([$this->north, $this->south]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $attempts = [];
        foreach ([$northGroup, $southGroup] as $group) {
            $workspace = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")->assertOk()->json();
            $attempts[] = $this->postJson("{$this->base}/students/{$student['id']}/enrollments", [
                'group_id' => $group['id'], 'group_revision' => $group['revision'],
                'currency_revision' => $workspace['student']['currency_revision'], 'joined_on' => '2026-09-28',
                'discount' => '0.00', 'discount_reason' => null,
                'version' => $workspace['student']['version'], 'request_id' => (string) Str::uuid(),
            ])->assertCreated()->json('attempt');
        }
        $accountUrl = "{$this->base}/students/{$student['id']}/account";
        $northPayment = $this->postJson("{$this->base}/students/{$student['id']}/payments", [
            'branch_id' => $this->north, 'method' => 'cash', 'received_on' => '2026-09-28',
            'amount' => '40.00', 'version' => $this->getJson($accountUrl)->json('account.version'),
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('payment');
        $northUrl = "{$this->base}/students/{$student['id']}/payments/{$northPayment['id']}";
        $options = $this->getJson("{$northUrl}/allocation-options")->assertOk()->assertJsonCount(2, 'fees')
            ->assertJsonFragment(['attempt_id' => $attempts[0]['id']])->assertJsonFragment(['attempt_id' => $attempts[1]['id']]);
        $crossTarget = [['attempt_id' => $attempts[1]['id'], 'amount' => '10.00']];
        $this->postJson("{$northUrl}/allocations/preview", ['targets' => $crossTarget, 'version' => $options->json('version')])
            ->assertOk()->assertJsonPath('source.branch_id', $this->north)
            ->assertJsonPath('source.available_before', '40.00')->assertJsonPath('source.available_after', '30.00')
            ->assertJsonPath('targets.0.branch_id', $this->south)->assertJsonPath('targets.0.remaining_before', '40.00')
            ->assertJsonPath('targets.0.remaining_after', '30.00')->assertJsonPath('cross_branch', true);
        $this->postJson("{$northUrl}/allocations", ['targets' => $crossTarget,
            'version' => $options->json('version'), 'request_id' => (string) Str::uuid()])->assertCreated()
            ->assertJsonPath('allocations.0.source_branch_id', $this->north)
            ->assertJsonPath('allocations.0.target_branch_id', $this->south);
        $request = ['targets' => [['attempt_id' => $attempts[0]['id'], 'amount' => '10.00']],
            'version' => $this->getJson("{$northUrl}/allocation-options")->json('version'), 'request_id' => (string) Str::uuid()];
        $this->grant([$this->north => ['branch_auditor']]);
        $this->asUser($this->staff);
        $this->getJson("{$northUrl}/allocation-options")->assertNotFound();
        $this->postJson("{$northUrl}/allocations", $request)->assertNotFound();
        $this->grant([$this->north => ['branch_auditor', 'accounting']]);
        $this->asUser($this->staff);
        $staffOptions = $this->getJson("{$northUrl}/allocation-options")->assertOk()->assertJsonCount(1, 'fees');
        $allocation = $this->postJson("{$northUrl}/allocations", [...$request, 'version' => $staffOptions->json('version')])
            ->assertCreated()->json('allocations.0');
        $this->assertStringContainsString('student.payment_allocated', $this->getJson("{$this->base}/audit")->assertOk()->getContent());
        $this->center->run(function () use ($southGroup, $attempts): void {
            DB::table('study_groups')->where('id', $southGroup['id'])->update(['name' => 'South private group']);
            DB::table('study_attempts')->where('id', $attempts[0]['id'])
                ->update(['current_group_id' => $southGroup['id']]);
        });
        $afterMove = $this->getJson("{$northUrl}/allocation-options")->assertOk()
            ->assertJsonPath('fees.0.group_name', $northGroup['name'])
            ->assertJsonPath('history.0.group_name', $northGroup['name']);
        $this->assertStringNotContainsString('South private group', $afterMove->getContent());
        $this->grant([$this->south => ['accounting']]);
        $this->asUser($this->staff);
        $this->getJson("{$northUrl}/allocation-options")->assertNotFound();
        $this->postJson("{$this->base}/students/{$student['id']}/allocations/{$allocation['id']}/reverse", [
            'reason' => 'تصحيح', 'version' => $this->getJson($accountUrl)->json('account.version'),
            'request_id' => (string) Str::uuid(),
        ])->assertNotFound();
    }

    public function test_cross_branch_credit_rechecks_grants_and_version_without_exposing_private_history(): void
    {
        $southGroup = $this->group($this->south, '80.00');
        $student = $this->student([$this->north, $this->south]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $enrollmentUrl = "{$this->base}/students/{$student['id']}/enrollments";
        $workspace = $this->getJson($enrollmentUrl)->assertOk()->json();
        $attempt = $this->postJson($enrollmentUrl, [
            'group_id' => $southGroup['id'], 'group_revision' => $southGroup['revision'],
            'currency_revision' => $workspace['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $workspace['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $accountUrl = "{$this->base}/students/{$student['id']}/account";
        $payment = $this->postJson("{$this->base}/students/{$student['id']}/payments", [
            'branch_id' => $this->north, 'method' => 'cash', 'received_on' => '2026-09-28',
            'amount' => '100.00', 'version' => $this->getJson($accountUrl)->json('account.version'),
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('payment');
        $url = "{$this->base}/students/{$student['id']}/payments/{$payment['id']}";
        $this->grant([$this->north => ['accounting', 'branch_auditor']]);
        $this->asUser($this->staff);
        $limited = $this->getJson("{$url}/allocation-options")->assertOk()->assertJsonCount(0, 'fees');
        $this->assertLessThanOrEqual(6, (int) $limited->headers->get('X-Courses-Query-Count'));
        $targets = [['attempt_id' => $attempt['id'], 'amount' => '40.00']];
        $this->postJson("{$url}/allocations/preview", ['targets' => $targets, 'version' => $limited->json('version')])
            ->assertNotFound();
        $this->asUser($this->owner);
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [$this->north => ['accounting', 'branch_auditor', 'financial_approval'],
                $this->south => ['financial_approval']],
        ])->assertUnprocessable();
        $this->grant([$this->north => ['accounting', 'branch_auditor'], $this->south => ['accounting']]);
        $this->asUser($this->staff);
        $both = $this->getJson("{$url}/allocation-options")->assertOk()->assertJsonCount(0, 'fees');
        $this->postJson("{$url}/allocations/preview", ['targets' => $targets, 'version' => $both->json('version')])
            ->assertForbidden();
        $this->grant([$this->north => ['accounting', 'branch_auditor', 'financial_approval'],
            $this->south => ['accounting', 'financial_approval']]);
        $this->asUser($this->staff);
        $approved = $this->getJson("{$url}/allocation-options")->assertOk()->assertJsonCount(1, 'fees');
        $previewRequest = ['targets' => $targets, 'version' => $approved->json('version')];
        $this->postJson("{$url}/allocations/preview", $previewRequest)->assertOk()
            ->assertJsonPath('source.available_before', '100.00')->assertJsonPath('source.available_after', '60.00')
            ->assertJsonPath('targets.0.remaining_before', '80.00')->assertJsonPath('targets.0.remaining_after', '40.00');
        $request = [...$previewRequest, 'request_id' => (string) Str::uuid()];
        $this->grant([$this->north => ['accounting', 'branch_auditor', 'financial_approval'],
            $this->south => ['accounting']]);
        $this->asUser($this->staff);
        $this->postJson("{$url}/allocations", $request)->assertForbidden();
        $this->center->run(fn () => $this->assertSame(0, DB::table('student_payment_allocations')->count()));
        $this->grant([$this->north => ['accounting', 'branch_auditor', 'financial_approval'],
            $this->south => ['accounting', 'financial_approval']]);
        $this->asUser($this->staff);
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT cross_allocation_audit_failure CHECK (event <> 'student.payment_allocated') NOT VALID"));
        try {
            $this->postJson("{$url}/allocations", $request)->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT cross_allocation_audit_failure'));
        }
        $this->center->run(fn () => $this->assertSame(0, DB::table('student_payment_allocations')->count()));
        $this->postJson("{$url}/allocations", $request)->assertCreated();
        $this->postJson("{$url}/allocations", $request)->assertOk();
        $this->center->run(function (): void {
            $allocation = DB::table('student_payment_allocations')->firstOrFail();
            $this->assertSame($this->north, (int) $allocation->source_branch_id);
            $this->assertSame($this->south, (int) $allocation->target_branch_id);
        });
        $this->postJson("{$url}/allocations", [...$request, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'student_account_changed');
        $this->getJson($accountUrl)->assertJsonPath('account.available_balance', '60.00')
            ->assertJsonPath('account.paid_total', '40.00')->assertJsonPath('account.debt', '40.00');
        $this->grant([$this->north => ['accounting', 'branch_auditor']]);
        $this->asUser($this->staff);
        $hiddenHistory = $this->getJson("{$url}/allocation-options")->assertOk()->assertJsonCount(0, 'history');
        $this->assertStringNotContainsString($attempt['id'], $hiddenHistory->getContent());
        $this->assertStringNotContainsString('student.payment_allocated', $this->getJson("{$this->base}/audit")->assertOk()->getContent());
        $sourceAudit = $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk();
        $this->assertStringNotContainsString('student.payment_allocated', $sourceAudit->getContent());
        $this->assertStringNotContainsString($attempt['id'], $sourceAudit->getContent());
        $this->postJson("{$url}/allocations", $request)->assertForbidden();
        $this->grant([$this->north => ['accounting', 'branch_auditor'], $this->south => ['accounting']]);
        $this->asUser($this->staff);
        $this->getJson("{$url}/allocation-options")->assertOk()->assertJsonCount(1, 'history')
            ->assertJsonPath('history.0.can_correct', false);
        $this->assertStringContainsString('student.payment_allocated', $this->getJson("{$this->base}/audit")->assertOk()->getContent());
        $this->assertStringContainsString('student.payment_allocated',
            $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()->getContent());
        $allocationId = $this->center->run(fn () => DB::table('student_payment_allocations')->value('id'));
        $reverseUrl = "{$this->base}/students/{$student['id']}/allocations/{$allocationId}/reverse";
        $this->postJson($reverseUrl, ['reason' => 'تصحيح', 'version' => $this->getJson($accountUrl)->json('account.version'),
            'request_id' => (string) Str::uuid()])->assertForbidden();
        $this->grant([$this->north => ['accounting', 'branch_auditor', 'financial_approval'],
            $this->south => ['accounting', 'financial_approval']]);
        $this->asUser($this->staff);
        $this->getJson("{$url}/allocation-options")->assertJsonPath('history.0.can_correct', true);
        $this->postJson($reverseUrl, ['reason' => 'تصحيح', 'version' => $this->getJson($accountUrl)->json('account.version'),
            'request_id' => (string) Str::uuid()])->assertCreated();
        $this->getJson($accountUrl)->assertJsonPath('account.available_balance', '100.00')
            ->assertJsonPath('account.paid_total', '0.00');
        $this->grant([$this->north => ['accounting', 'branch_auditor']]);
        $this->asUser($this->staff);
        $sourceAudit = $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()->getContent();
        $this->assertStringNotContainsString('student.payment_allocated', $sourceAudit);
        $this->assertStringNotContainsString('student.payment_allocation_reversed', $sourceAudit);
    }

    public function test_cross_branch_credit_settlement_releases_only_the_excess_to_its_source(): void
    {
        $group = $this->group($this->south, '100.00');
        $student = $this->student([$this->north, $this->south]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $enrollmentUrl = "{$this->base}/students/{$student['id']}/enrollments";
        $workspace = $this->getJson($enrollmentUrl)->json();
        $attempt = $this->postJson($enrollmentUrl, [
            'group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $workspace['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $workspace['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $accountUrl = "{$this->base}/students/{$student['id']}/account";
        $payment = $this->postJson("{$this->base}/students/{$student['id']}/payments", [
            'branch_id' => $this->north, 'method' => 'cash', 'received_on' => '2026-09-28',
            'amount' => '90.00', 'version' => $this->getJson($accountUrl)->json('account.version'),
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('payment');
        $allocationUrl = "{$this->base}/students/{$student['id']}/payments/{$payment['id']}";
        $this->postJson("{$allocationUrl}/allocations", [
            'targets' => [['attempt_id' => $attempt['id'], 'amount' => '90.00']],
            'version' => $this->getJson("{$allocationUrl}/allocation-options")->json('version'),
            'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $feeUrl = "{$this->base}/students/{$student['id']}/fees/{$attempt['fee']['id']}/adjustments";
        $preview = $this->getJson("{$feeUrl}?new_due=50.00")->assertOk()
            ->assertJsonPath('preview.account_after.available_balance', '40.00')
            ->assertJsonPath('preview.fee_paid_after', '50.00');
        $this->postJson($feeUrl, [
            'new_due' => '50.00', 'reason' => 'تسوية صريحة بعد تغير الدراسة',
            'replaces_adjustment_id' => null, 'version' => $preview->json('version'),
            'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->getJson($accountUrl)->assertJsonPath('account.available_balance', '40.00')
            ->assertJsonPath('account.paid_total', '50.00')->assertJsonPath('account.debt', '0.00');
        $this->center->run(function (): void {
            $active = ActiveStudentAllocations::query()->get();
            $this->assertSame(1, $active->count());
            $this->assertSame('50.00', $active->first()->amount);
            $this->assertSame($this->north, (int) $active->first()->source_branch_id);
            $this->assertSame($this->south, (int) $active->first()->target_branch_id);
        });
        $this->grant([$this->south => ['accounting', 'branch_auditor', 'financial_approval']]);
        $this->asUser($this->staff);
        $this->assertStringNotContainsString('student.fee_settled', $this->getJson("{$this->base}/audit")->assertOk()->getContent());
        $targetAudit = $this->getJson("{$this->base}/branches/{$this->south}/audit")->assertOk()->getContent();
        $this->assertStringNotContainsString('student.fee_settled', $targetAudit);
        $this->assertStringNotContainsString($payment['id'], $targetAudit);
        $this->getJson("{$feeUrl}?new_due=40.00")->assertForbidden();
        $this->grant([$this->north => ['accounting'], $this->south => ['accounting', 'branch_auditor', 'financial_approval']]);
        $this->asUser($this->staff);
        $this->assertStringContainsString('student.fee_settled', $this->getJson("{$this->base}/audit")->assertOk()->getContent());
        $this->assertStringContainsString('student.fee_settled',
            $this->getJson("{$this->base}/branches/{$this->south}/audit")->assertOk()->getContent());
    }

    public function test_allocation_correction_moves_a_real_payment_atomically_without_changing_receipt(): void
    {
        $this->center->run(function (): void {
            $this->assertTrue(DB::table('pg_indexes')
                ->where('tablename', 'student_payment_allocations')
                ->where('indexname', 'student_payment_allocations_submission_id_index')->exists());
        });
        $northGroup = $this->group($this->north, '400.00');
        $southGroup = $this->group($this->south, '400.00');
        $student = $this->student([$this->north, $this->south]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $enrollmentUrl = "{$this->base}/students/{$student['id']}/enrollments";
        $attempts = [];
        foreach ([$northGroup, $southGroup] as $group) {
            $workspace = $this->getJson($enrollmentUrl)->assertOk()->json();
            $attempts[] = $this->postJson($enrollmentUrl, [
                'group_id' => $group['id'], 'group_revision' => $group['revision'],
                'currency_revision' => $workspace['student']['currency_revision'], 'joined_on' => '2026-09-28',
                'discount' => '0.00', 'discount_reason' => null, 'version' => $workspace['student']['version'],
                'request_id' => (string) Str::uuid(),
            ])->assertCreated()->json('attempt');
        }
        $accountUrl = "{$this->base}/students/{$student['id']}/account";
        $payment = $this->postJson("{$this->base}/students/{$student['id']}/payments", [
            'branch_id' => $this->north, 'method' => 'cash', 'received_on' => '2026-09-28',
            'amount' => '1000.00', 'version' => $this->getJson($accountUrl)->json('account.version'),
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('payment');
        $paymentUrl = "{$this->base}/students/{$student['id']}/payments/{$payment['id']}";
        $allocation = $this->postJson("{$paymentUrl}/allocations", [
            'targets' => [['attempt_id' => $attempts[0]['id'], 'amount' => '400.00']],
            'version' => $this->getJson("{$paymentUrl}/allocation-options")->json('version'),
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('allocations.0');
        $transferGroup = $this->group($this->south, '0.00');
        [$sourceLecture, $destinationLecture] = $this->center->run(fn () => [
            DB::table('plan_lectures')->where('plan_version_id', $northGroup['plan_version_id'])->value('id'),
            DB::table('plan_lectures')->where('plan_version_id', $transferGroup['plan_version_id'])->value('id'),
        ]);
        $this->postJson("{$this->base}/content-equivalences", [
            'source_plan_version_id' => $northGroup['plan_version_id'],
            'target_plan_version_id' => $transferGroup['plan_version_id'],
            'source_lecture_ids' => [$sourceLecture], 'target_lecture_ids' => [$destinationLecture],
            'reason' => 'معادلة قبل نقل الدراسة', 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $transferUrl = "{$enrollmentUrl}/{$attempts[0]['id']}/transfer";
        $transferPreview = $this->getJson("{$transferUrl}/preview?".http_build_query([
            'group_id' => $transferGroup['id'], 'transferred_on' => '2026-09-28',
        ]))->assertOk()->json('preview');
        $this->postJson($transferUrl, [
            'group_id' => $transferGroup['id'], 'group_revision' => $transferGroup['revision'],
            'transferred_on' => '2026-09-28', 'revision' => $attempts[0]['revision'],
            'preview_hash' => $transferPreview['hash'], 'reason' => 'نقل أكاديمي مستقل عن المال',
            'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->getJson($accountUrl)->assertJsonPath('account.available_balance', '600.00')
            ->assertJsonPath('account.paid_total', '400.00');
        $this->center->run(function () use ($attempts): void {
            $this->assertSame(1, DB::table('student_payment_allocations')->count());
            $this->assertSame($this->south, (int) DB::table('study_attempts')->where('id', $attempts[0]['id'])->value('branch_id'));
            $this->assertSame($this->north, (int) DB::table('study_attempt_fees')->where('attempt_id', $attempts[0]['id'])->value('branch_id'));
        });
        $url = "{$this->base}/students/{$student['id']}/allocations/{$allocation['id']}/corrections";
        $version = $this->getJson($accountUrl)->json('account.version');
        $this->postJson("{$url}/preview", [
            'target_attempt_id' => strtoupper($attempts[0]['id']), 'version' => $version,
        ])->assertUnprocessable();
        $this->postJson($url, [
            'target_attempt_id' => strtoupper($attempts[0]['id']), 'reason' => 'لن تنقل إلى التسجيل نفسه',
            'version' => $version, 'request_id' => (string) Str::uuid(),
        ])->assertUnprocessable();
        $previewRequest = ['target_attempt_id' => $attempts[1]['id'], 'version' => $version];
        $this->postJson("{$url}/preview", $previewRequest)->assertOk()
            ->assertJsonPath('original.attempt_id', $attempts[0]['id'])
            ->assertJsonPath('source.received_amount', '1000.00')
            ->assertJsonPath('source.available_before', '600.00')
            ->assertJsonPath('source.available_after', '600.00')
            ->assertJsonPath('target.attempt_id', $attempts[1]['id'])
            ->assertJsonPath('account.debt_before', '400.00')
            ->assertJsonPath('account.debt_after', '400.00');
        $payload = [...$previewRequest, 'reason' => 'خُصص للتسجيل الخطأ', 'request_id' => (string) Str::uuid()];
        $this->grant([$this->north => ['accounting', 'branch_auditor', 'financial_approval']]);
        $this->asUser($this->staff);
        $previewRequest['version'] = $this->getJson($accountUrl)->json('account.version');
        $payload['version'] = $previewRequest['version'];
        $this->postJson("{$url}/preview", $previewRequest)->assertNotFound();
        $this->postJson($url, $payload)->assertNotFound();
        $this->grant([$this->north => ['accounting', 'branch_auditor', 'financial_approval'],
            $this->south => ['accounting']]);
        $this->asUser($this->staff);
        $previewRequest['version'] = $this->getJson($accountUrl)->json('account.version');
        $this->postJson("{$url}/preview", $previewRequest)->assertForbidden();
        $this->grant([$this->north => ['accounting', 'branch_auditor', 'financial_approval'],
            $this->south => ['accounting', 'financial_approval']]);
        $this->asUser($this->staff);
        $payload['version'] = $this->getJson($accountUrl)->json('account.version');
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT correction_audit_failure CHECK (event <> 'student.payment_allocation_corrected') NOT VALID"));
        try {
            $this->postJson($url, $payload)->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT correction_audit_failure'));
        }
        $this->center->run(fn () => $this->assertSame(0, DB::table('student_payment_allocation_reversals')->count()));
        $saved = $this->postJson($url, $payload)->assertCreated()->json();
        $this->postJson($url, $payload)->assertOk()->assertJsonPath('allocation.id', $saved['allocation']['id']);
        $this->postJson($url, [...$payload, 'reason' => 'سبب مختلف'])->assertConflict()
            ->assertJsonPath('code', 'allocation_request_changed');
        $this->postJson($url, [...$payload, 'request_id' => (string) Str::uuid()])->assertConflict()
            ->assertJsonPath('code', 'student_account_changed');
        $this->postJson($url, [...$payload, 'request_id' => (string) Str::uuid(), 'amount' => '1.00'])
            ->assertUnprocessable()->assertJsonValidationErrors('amount');
        $history = $this->getJson("{$paymentUrl}/allocation-options")->assertOk()->json('history');
        $this->assertSame($saved['allocation']['id'], collect($history)->firstWhere('id', $allocation['id'])['corrected_allocation_id']);
        $this->assertSame('correct', collect($history)->firstWhere('id', $allocation['id'])['reversal_kind']);
        $this->getJson($accountUrl)->assertJsonPath('account.received_total', '1000.00')
            ->assertJsonPath('account.available_balance', '600.00')->assertJsonPath('account.debt', '400.00');
        $this->center->run(function () use ($payment, $allocation, $saved): void {
            $this->assertSame('1000.00', DB::table('student_payments')->where('id', $payment['id'])->value('amount'));
            $this->assertSame('2026-09-28', DB::table('student_payments')->where('id', $payment['id'])->value('received_on'));
            $this->assertSame(2, DB::table('student_payment_allocations')->count());
            $this->assertSame($saved['reversal']['submission_id'], $saved['allocation']['submission_id']);
            $this->assertSame($allocation['id'], $saved['reversal']['allocation_id']);
            $this->assertSame('خُصص للتسجيل الخطأ', $saved['reversal']['reason']);
            try {
                (require database_path('migrations/tenant/2026_09_29_030000_allow_student_allocation_corrections.php'))->down();
                $this->fail('Approved corrections must prevent rollback of their submission kind.');
            } catch (\RuntimeException $exception) {
                $this->assertStringContainsString('Cannot roll back', $exception->getMessage());
            }
        });
        $this->grant([$this->north => ['accounting', 'branch_auditor', 'financial_approval']]);
        $this->asUser($this->staff);
        $this->postJson($url, $payload)->assertNotFound();
        $this->getJson("{$paymentUrl}/allocation-options")->assertOk()->assertJsonCount(0, 'history');
        $this->assertStringNotContainsString('student.payment_allocation_corrected',
            $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()->getContent());
        $this->asUser($this->owner);
        $creditUrl = "{$this->base}/students/{$student['id']}/allocations/{$saved['allocation']['id']}/corrections";
        $creditVersion = $this->getJson($accountUrl)->json('account.version');
        $this->postJson("{$creditUrl}/preview", ['target_attempt_id' => null, 'version' => $creditVersion])->assertOk()
            ->assertJsonPath('account.available_after', '1000.00')->assertJsonPath('account.debt_after', '800.00');
        $this->postJson($creditUrl, ['target_attempt_id' => null, 'reason' => 'إعادة إلى الرصيد',
            'version' => $creditVersion, 'request_id' => (string) Str::uuid()])->assertCreated()->assertJsonPath('allocation', null);
        $this->getJson($accountUrl)->assertJsonPath('account.received_total', '1000.00')
            ->assertJsonPath('account.available_balance', '1000.00')->assertJsonPath('account.debt', '800.00');

        $west = $this->postJson("{$this->base}/branches", ['name' => 'West', 'slug' => 'west'])
            ->assertCreated()->json('branch.id');
        $this->center->run(fn () => DB::table('student_branches')->insert([
            'student_id' => $student['id'], 'branch_id' => $west, 'created_at' => now(),
        ]));
        $this->postJson("{$this->base}/students/{$student['id']}/payments", [
            'branch_id' => $west, 'method' => 'cash', 'received_on' => '2026-09-28',
            'amount' => '500.00', 'version' => $this->getJson($accountUrl)->json('account.version'),
            'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $nextAllocation = $this->postJson("{$paymentUrl}/allocations", [
            'targets' => [['attempt_id' => $attempts[0]['id'], 'amount' => '100.00']],
            'version' => $this->getJson("{$paymentUrl}/allocation-options")->json('version'),
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('allocations.0');
        $scopedUrl = "{$this->base}/students/{$student['id']}/allocations/{$nextAllocation['id']}/corrections";
        $scopedVersion = $this->getJson($accountUrl)->json('account.version');
        $this->postJson("{$scopedUrl}/preview", [
            'target_attempt_id' => $attempts[1]['id'], 'version' => $scopedVersion,
        ])->assertOk()->assertJsonPath('account.available_before', '900.00')
            ->assertJsonPath('account.debt_before', '700.00');
        $this->postJson($scopedUrl, [
            'target_attempt_id' => $attempts[1]['id'], 'reason' => 'تصحيح بعد دفعة فرع مستقل',
            'version' => $scopedVersion, 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->getJson($accountUrl)->assertJsonPath('account.available_balance', '1400.00');
        $this->center->run(function () use ($west): void {
            $details = json_decode(DB::table('center_audit_logs')
                ->where('event', 'student.payment_allocation_corrected')->orderByDesc('id')->value('details'), true);
            $this->assertSame('900.00', $details['account_before']['available_balance']);
            $this->assertSame([$this->north, $this->south], $details['account_scope_branch_ids']);
            $this->assertNotContains($west, $details['account_scope_branch_ids']);
        });
        $this->grant([$this->north => ['accounting', 'branch_auditor', 'financial_approval'],
            $this->south => ['accounting', 'financial_approval']]);
        $this->asUser($this->staff);
        $audit = $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()->json('entries');
        $visibleCorrection = collect($audit)->firstWhere('event', 'student.payment_allocation_corrected');
        $this->assertSame('تصحيح بعد دفعة فرع مستقل', json_decode($visibleCorrection['details'], true)['reason']);
    }

    public function test_refund_and_approved_correction_preserve_cash_history_and_available_credit(): void
    {
        $group = $this->group($this->north, '500.00');
        $student = $this->student([$this->north, $this->south]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $enrollmentUrl = "{$this->base}/students/{$student['id']}/enrollments";
        $workspace = $this->getJson($enrollmentUrl)->assertOk()->json();
        $attempt = $this->postJson($enrollmentUrl, [
            'group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $workspace['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $workspace['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $accountUrl = "{$this->base}/students/{$student['id']}/account";
        $payment = $this->postJson("{$this->base}/students/{$student['id']}/payments", [
            'branch_id' => $this->north, 'method' => 'cash', 'received_on' => '2026-09-28',
            'amount' => '500.00', 'version' => $this->getJson($accountUrl)->json('account.version'),
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('payment');
        $paymentUrl = "{$this->base}/students/{$student['id']}/payments/{$payment['id']}";
        $refundUrl = "{$paymentUrl}/refunds";
        $this->grant([$this->north => ['accounting']]);
        $this->asUser($this->staff);
        $staffVersion = $this->getJson($accountUrl)->assertOk()->json('account.version');
        $this->getJson($refundUrl)->assertOk()->assertJsonPath('can_refund', false);
        $this->postJson("{$refundUrl}/preview", [
            'amount' => '200.00', 'refunded_on' => '2026-09-28', 'reason' => 'رد فعلي',
            'version' => $staffVersion,
        ])->assertForbidden();
        $this->grant([$this->north => ['accounting', 'financial_approval']]);
        $this->asUser($this->staff);
        $staffVersion = $this->getJson($accountUrl)->json('account.version');
        $this->postJson("{$refundUrl}/preview", [
            'amount' => '200.00', 'refunded_on' => '2026-09-27', 'reason' => 'قبل القبض',
            'version' => $staffVersion,
        ])->assertUnprocessable()->assertJsonValidationErrors('refunded_on');
        $this->postJson("{$refundUrl}/preview", [
            'amount' => '200.00', 'refunded_on' => '2026-09-28', 'reason' => 'رد فعلي',
            'version' => $staffVersion,
        ])->assertOk()->assertJsonPath('payment.received_amount', '500.00')
            ->assertJsonPath('payment.available_before', '500.00')
            ->assertJsonPath('available_after', '300.00');
        $refundRequest = ['amount' => '200.00', 'refunded_on' => '2026-09-28',
            'reason' => 'رد فعلي', 'version' => $staffVersion, 'request_id' => (string) Str::uuid()];
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT refund_audit_failure CHECK (event <> 'student.refund_recorded') NOT VALID"));
        try {
            $this->postJson($refundUrl, $refundRequest)->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT refund_audit_failure'));
        }
        $this->center->run(fn () => $this->assertSame(0, DB::table('student_refunds')->count()));
        $refund = $this->postJson($refundUrl, $refundRequest)->assertCreated()->json('refund');
        $this->postJson($refundUrl, $refundRequest)->assertOk()->assertJsonPath('refund.id', $refund['id']);
        $this->postJson($refundUrl, [...$refundRequest, 'amount' => '201.00'])->assertConflict()
            ->assertJsonPath('code', 'refund_request_changed');
        $this->getJson($accountUrl)->assertJsonPath('account.received_total', '500.00')
            ->assertJsonPath('account.refunded_total', '200.00')->assertJsonPath('account.available_balance', '300.00');
        $this->asUser($this->owner);
        $this->getJson($enrollmentUrl)->assertJsonPath('balance.available_credit', '300.00');
        $allocation = $this->postJson("{$paymentUrl}/allocations", [
            'targets' => [['attempt_id' => $attempt['id'], 'amount' => '300.00']],
            'version' => $this->getJson("{$paymentUrl}/allocation-options")->json('version'),
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('allocations.0');
        $this->getJson($accountUrl)->assertJsonPath('account.available_balance', '0.00')
            ->assertJsonPath('account.debt', '200.00');
        $this->postJson($refundUrl, [
            'amount' => '1.00', 'refunded_on' => '2026-09-28', 'reason' => 'لا يوجد رصيد',
            'version' => $this->getJson($accountUrl)->json('account.version'), 'request_id' => (string) Str::uuid(),
        ])->assertConflict()->assertJsonPath('code', 'refund_exceeds_available');
        $correctionUrl = "{$this->base}/students/{$student['id']}/refunds/{$refund['id']}/corrections";
        $version = $this->getJson($accountUrl)->json('account.version');
        $this->postJson("{$correctionUrl}/preview", ['correct_amount' => '250.00', 'version' => $version])
            ->assertConflict()->assertJsonPath('code', 'refund_exceeds_available');
        $this->postJson("{$correctionUrl}/preview", ['correct_amount' => '100.00', 'version' => $version])
            ->assertOk()->assertJsonPath('payment.received_amount', '500.00')
            ->assertJsonPath('payment.allocated_amount', '300.00')
            ->assertJsonPath('payment.available_before', '0.00')
            ->assertJsonPath('available_after', '100.00')
            ->assertJsonCount(1, 'later_movements');
        $correction = ['correct_amount' => '100.00', 'reason' => 'المدفوع فعليًا مئة فقط',
            'version' => $version, 'request_id' => (string) Str::uuid()];
        $saved = $this->postJson($correctionUrl, $correction)->assertCreated()->json();
        $this->postJson($correctionUrl, $correction)->assertOk()
            ->assertJsonPath('replacement.id', $saved['replacement']['id']);
        $this->postJson($correctionUrl, [...$correction, 'reason' => 'سبب مختلف'])->assertConflict();
        $this->postJson("{$correctionUrl}/preview", [
            'correct_amount' => '50.00', 'version' => $this->getJson($accountUrl)->json('account.version'),
        ])->assertConflict()->assertJsonPath('code', 'refund_already_corrected');
        $this->getJson($accountUrl)->assertJsonPath('account.received_total', '500.00')
            ->assertJsonPath('account.allocated_total', '300.00')
            ->assertJsonPath('account.refunded_total', '100.00')
            ->assertJsonPath('account.available_balance', '100.00');
        $this->getJson($enrollmentUrl)->assertJsonPath('balance.available_credit', '100.00');
        $history = $this->getJson($refundUrl)->assertOk()->json('history');
        $this->assertSame($saved['replacement']['id'], collect($history)->firstWhere('id', $refund['id'])['replacement_refund_id']);
        $this->center->run(function () use ($payment, $refund, $saved, $allocation): void {
            $this->assertSame('500.00', DB::table('student_payments')->where('id', $payment['id'])->value('amount'));
            $this->assertSame(2, DB::table('student_refunds')->count());
            $this->assertSame($refund['id'], $saved['reversal']['refund_id']);
            $this->assertSame('300.00', DB::table('student_payment_allocations')->where('id', $allocation['id'])->value('amount'));
            try {
                (require database_path('migrations/tenant/2026_09_29_040000_create_student_refunds.php'))->down();
                $this->fail('Approved refunds must prevent rollback.');
            } catch (\RuntimeException $exception) {
                $this->assertStringContainsString('Cannot roll back', $exception->getMessage());
            }
        });
        $this->grant([$this->north => ['accounting']]);
        $this->asUser($this->staff);
        $this->postJson($correctionUrl, $correction)->assertForbidden();
    }

    public function test_suspended_incomplete_student_can_pay_and_allocate_existing_debt_with_current_branch_grants(): void
    {
        $group = $this->group($this->north, '100.00');
        $student = $this->student([$this->north, $this->south]);
        $studentUrl = "{$this->base}/students/{$student['id']}";
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $enrollment = $this->getJson("{$studentUrl}/enrollments")->assertOk()->json();
        $attempt = $this->postJson("{$studentUrl}/enrollments", [
            'group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $enrollment['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $enrollment['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $this->postJson("{$this->base}/student-custom-fields", [
            'id' => (string) Str::uuid(), 'label' => 'بيان مطلوب جديد', 'type' => 'text',
            'required' => true, 'position' => 1, 'options' => [],
        ])->assertCreated();
        $this->postJson("{$studentUrl}/status", [
            'status' => 'suspended', 'reason' => 'توقف مؤقت عن الدراسة', 'status_revision' => 1,
            'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->getJson($studentUrl)->assertOk()->assertJsonPath('students.0.missing_custom_fields', 1);

        $this->grant([$this->north => ['accounting']]);
        $this->asUser($this->staff);
        $accountUrl = "{$studentUrl}/account";
        $before = $this->getJson($accountUrl)->assertOk()
            ->assertJsonPath('account.student_status', 'suspended')
            ->assertJsonPath('account.due_total', '100.00')
            ->assertJsonPath('account.debt', '100.00');
        $this->assertMatchesRegularExpression('/^[1-9]\d*$/', (string) $before->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $before->headers->get('X-Courses-Query-Count'));
        $paymentRequest = [
            'branch_id' => $this->north, 'method' => 'cash', 'received_on' => '2026-09-28',
            'amount' => '60.00', 'version' => $before->json('account.version'), 'request_id' => (string) Str::uuid(),
        ];
        $payment = $this->postJson("{$studentUrl}/payments", $paymentRequest)->assertCreated()->json('payment');
        $this->postJson("{$studentUrl}/payments", $paymentRequest)->assertOk()->assertJsonPath('payment.id', $payment['id']);
        $optionsUrl = "{$studentUrl}/payments/{$payment['id']}/allocation-options";
        $options = $this->getJson($optionsUrl)->assertOk()->assertJsonPath('fees.0.attempt_id', $attempt['id']);
        $allocationRequest = [
            'targets' => [['attempt_id' => $attempt['id'], 'amount' => '40.00']],
            'version' => $options->json('version'), 'request_id' => (string) Str::uuid(),
        ];
        $allocationUrl = "{$studentUrl}/payments/{$payment['id']}/allocations";
        $allocation = $this->postJson($allocationUrl, $allocationRequest)->assertCreated()->json('allocations.0');
        $this->postJson($allocationUrl, $allocationRequest)->assertOk()->assertJsonPath('allocations.0.id', $allocation['id']);
        $after = $this->getJson($accountUrl)->assertOk()
            ->assertJsonPath('account.student_status', 'suspended')
            ->assertJsonPath('account.received_total', '60.00')
            ->assertJsonPath('account.allocated_total', '40.00')
            ->assertJsonPath('account.paid_total', '40.00')
            ->assertJsonPath('account.available_balance', '20.00')
            ->assertJsonPath('account.debt', '60.00');
        $this->assertMatchesRegularExpression('/^[1-9]\d*$/', (string) $after->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $after->headers->get('X-Courses-Query-Count'));
        $this->center->run(function () use ($student): void {
            $this->assertSame(1, DB::table('study_attempt_fees')->where('student_id', $student['id'])->count());
            $this->assertSame(1, DB::table('student_payments')->where('student_id', $student['id'])->count());
            $this->assertSame(1, DB::table('student_payment_allocations')->where('student_id', $student['id'])->count());
        });

        $this->grant([$this->south => ['accounting']]);
        $this->asUser($this->staff);
        $hidden = $this->getJson($accountUrl)->assertOk()->assertJsonCount(0, 'payments')
            ->assertJsonPath('account.due_total', '0.00')
            ->assertJsonPath('account.received_total', '0.00');
        $this->assertStringNotContainsString('60.00', $hidden->getContent());
        $this->getJson($optionsUrl)->assertNotFound();
        $this->postJson($allocationUrl, $allocationRequest)->assertNotFound();
        $this->postJson("{$studentUrl}/payments", $paymentRequest)->assertForbidden();
        $this->grant([$this->south => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->getJson($accountUrl)->assertNotFound();
    }

    public function test_financial_notes_follow_payment_and_allocation_permissions_without_changing_balances(): void
    {
        $group = $this->group($this->north, '100.00');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $enrollment = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")->assertOk()->json();
        $this->postJson("{$this->base}/students/{$student['id']}/enrollments", [
            'group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $enrollment['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $enrollment['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $accountUrl = "{$this->base}/students/{$student['id']}/account";
        $payment = $this->postJson("{$this->base}/students/{$student['id']}/payments", [
            'branch_id' => $this->north, 'method' => 'cash', 'received_on' => '2026-09-28', 'amount' => '80.00',
            'version' => $this->getJson($accountUrl)->json('account.version'), 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('payment');
        $paymentUrl = "{$this->base}/students/{$student['id']}/payments/{$payment['id']}";
        $options = $this->getJson("{$paymentUrl}/allocation-options")->assertOk()->json();
        $allocation = $this->postJson("{$paymentUrl}/allocations", [
            'targets' => [['attempt_id' => $options['fees'][0]['attempt_id'], 'amount' => '30.00']],
            'version' => $options['version'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('allocations.0');
        $allocationUrl = "{$this->base}/students/{$student['id']}/allocations/{$allocation['id']}/note";
        $before = $this->getJson($accountUrl)->assertOk()->json('account');

        foreach (["{$paymentUrl}/note" => 'payment', $allocationUrl => 'allocation'] as $url => $type) {
            $this->getJson($url)->assertOk()->assertJsonPath('note', null)->assertJsonPath('can_edit', true);
            $request = ['body' => "ملاحظة {$type} مالية", 'important' => false, 'revision' => 0,
                'request_id' => (string) Str::uuid()];
            $created = $this->putJson($url, $request)->assertCreated()->assertJsonPath('note.revision', 1)->json('note');
            $this->putJson($url, $request)->assertOk()->assertJsonPath('note.id', $created['id']);
            $this->putJson($url, [...$request, 'body' => 'تغيير الطلب'])->assertConflict()->assertJsonPath('code', 'note_request_changed');
            $this->putJson($url, [...$request, 'request_id' => (string) Str::uuid()])->assertConflict()->assertJsonPath('code', 'note_changed');
            $this->putJson($url, ['body' => "تعديل {$type}", 'important' => true, 'revision' => 1,
                'request_id' => (string) Str::uuid()])->assertOk()->assertJsonPath('note.revision', 2);
            $this->getJson($url)->assertOk()->assertJsonCount(2, 'versions')->assertJsonPath('note.important', true);
        }
        $unifiedUrl = "{$this->base}/students/{$student['id']}/notes";
        $financialNotes = $this->getJson($unifiedUrl)->assertOk()->assertJsonCount(2, 'entries');
        $this->assertLessThanOrEqual(6, (int) $financialNotes->headers->get('X-Courses-Query-Count'));
        $paymentNoteId = collect($financialNotes->json('entries'))->firstWhere('event_type', 'payment')['id'];
        $this->getJson("{$unifiedUrl}/{$paymentNoteId}")->assertOk()->assertJsonCount(2, 'versions');
        $summary = $this->getJson("{$this->base}/students/{$student['id']}?tab=notes")->assertOk()
            ->assertJsonCount(2, 'important_notes')->assertJsonCount(2, 'student_notes.entries');
        $this->assertSame($payment['id'], collect($summary->json('important_notes'))->firstWhere('event_type', 'payment')['payment_id']);
        $this->assertSame($payment['id'], collect($summary->json('important_notes'))->firstWhere('event_type', 'allocation')['payment_id']);
        $after = $this->getJson($accountUrl)->assertOk()->json('account');
        $this->assertSame($before['version'], $after['version']);
        $this->assertSame($before['available_balance'], $after['available_balance']);
        $this->assertSame($before['paid_total'], $after['paid_total']);
        $this->assertStringNotContainsString('ملاحظة payment مالية', $this->getJson($accountUrl)->getContent());
        $this->center->run(function () use ($payment, $allocation): void {
            $this->assertSame('80.00', DB::table('student_payments')->where('id', $payment['id'])->value('amount'));
            $this->assertSame('30.00', DB::table('student_payment_allocations')->where('id', $allocation['id'])->value('amount'));
            $this->assertSame(4, DB::table('student_event_note_revisions')->count());
            $this->assertStringNotContainsString('ملاحظة', DB::table('center_audit_logs')->where('event', 'student.payment_note_created')->value('details'));
        });

        $this->grant([$this->north => ['branch_auditor']]);
        $this->asUser($this->staff);
        $this->getJson("{$paymentUrl}/note")->assertNotFound();
        $this->getJson($allocationUrl)->assertNotFound();
        $this->getJson($unifiedUrl)->assertOk()->assertJsonCount(0, 'entries');
        $this->getJson("{$unifiedUrl}/{$paymentNoteId}")->assertNotFound();
        $this->putJson("{$paymentUrl}/note", ['body' => 'محجوب', 'important' => false, 'revision' => 2,
            'request_id' => (string) Str::uuid()])->assertNotFound();
        $this->assertStringNotContainsString('student.payment_note_created', $this->getJson("{$this->base}/audit")->getContent());
        $branchAudit = $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()->getContent();
        $this->assertStringNotContainsString('student.payment_note_created', $branchAudit);
        $this->assertStringNotContainsString('student.allocation_note_created', $branchAudit);
        $this->grant([$this->north => ['branch_auditor', 'accounting']]);
        $this->asUser($this->staff);
        $this->getJson($unifiedUrl)->assertOk()->assertJsonCount(2, 'entries');
        $visibleAudit = $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()->getContent();
        $this->assertStringContainsString('student.payment_note_created', $visibleAudit);
        $this->assertStringContainsString('student.allocation_note_created', $visibleAudit);
        $this->assertStringNotContainsString('ملاحظة payment مالية', $visibleAudit);
        $this->grant([$this->south => ['branch_auditor', 'accounting']]);
        $this->asUser($this->staff);
        $this->getJson("{$paymentUrl}/note")->assertNotFound();
        $this->getJson($allocationUrl)->assertNotFound();
        $this->getJson($accountUrl)->assertNotFound();
    }

    public function test_withdrawal_closes_only_the_academic_association_and_repeat_creates_a_new_fee(): void
    {
        $group = $this->group($this->north, '100.00');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $initial = $this->getJson($url)->json();
        $first = $this->postJson($url, [
            'group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $initial['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $initial['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $accountUrl = "{$this->base}/students/{$student['id']}/account";
        $account = $this->getJson($accountUrl)->json('account');
        $payment = $this->postJson("{$this->base}/students/{$student['id']}/payments", [
            'branch_id' => $this->north, 'method' => 'cash', 'received_on' => '2026-09-28',
            'amount' => '40.00', 'version' => $account['version'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('payment');
        $options = $this->getJson("{$this->base}/students/{$student['id']}/payments/{$payment['id']}/allocation-options")->json();
        $allocation = $this->postJson("{$this->base}/students/{$student['id']}/payments/{$payment['id']}/allocations", [
            'targets' => [['attempt_id' => $first['id'], 'amount' => '30.00']],
            'version' => $options['version'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('allocations.0');
        $paymentNoteUrl = "{$this->base}/students/{$student['id']}/payments/{$payment['id']}/note";
        $allocationNoteUrl = "{$this->base}/students/{$student['id']}/allocations/{$allocation['id']}/note";
        foreach ([$paymentNoteUrl => 'دفعة محفوظة قبل الانسحاب', $allocationNoteUrl => 'تخصيص محفوظ قبل الانسحاب'] as $noteUrl => $body) {
            $this->putJson($noteUrl, ['body' => $body, 'important' => true, 'revision' => 0,
                'request_id' => (string) Str::uuid()])->assertCreated()->assertJsonPath('note.body', $body);
        }
        $withdrawUrl = "{$url}/{$first['id']}/withdraw";
        $withdrawal = ['withdrawn_on' => '2026-09-28', 'reason' => 'طلب الطالب إيقاف الدراسة',
            'revision' => $first['revision'], 'request_id' => (string) Str::uuid()];
        $this->postJson($withdrawUrl, [...$withdrawal, 'withdrawn_on' => '2026-09-27', 'request_id' => (string) Str::uuid()])->assertUnprocessable();
        $this->postJson($withdrawUrl, [...$withdrawal, 'reason' => '  ', 'request_id' => (string) Str::uuid()])->assertUnprocessable();
        $closed = $this->postJson($withdrawUrl, $withdrawal)->assertOk()
            ->assertJsonPath('attempt.status', 'withdrawn')
            ->assertJsonPath('attempt.withdrawal.reason', $withdrawal['reason'])->json('attempt');
        $this->postJson($withdrawUrl, $withdrawal)->assertOk()->assertJsonPath('attempt.id', $first['id']);
        $this->postJson($withdrawUrl, [...$withdrawal, 'request_id' => (string) Str::uuid()])->assertConflict();
        $this->getJson($paymentNoteUrl)->assertOk()->assertJsonPath('note.body', 'دفعة محفوظة قبل الانسحاب');
        $this->getJson($allocationNoteUrl)->assertOk()->assertJsonPath('note.body', 'تخصيص محفوظ قبل الانسحاب');
        $this->center->run(function () use ($first): void {
            $this->assertSame('2026-09-28', DB::table('study_attempt_group_periods')->where('attempt_id', $first['id'])->value('left_on'));
            $this->assertSame(1, DB::table('study_attempt_withdrawals')->where('attempt_id', $first['id'])->count());
            $this->assertSame(1, DB::table('study_attempt_fees')->where('attempt_id', $first['id'])->count());
            $this->assertSame(1, DB::table('student_payments')->count());
            $this->assertSame(1, DB::table('student_payment_allocations')->count());
        });
        $beforeRepeat = $this->getJson($url)->assertOk()->assertJsonPath('balance.debt', '70.00')
            ->assertJsonPath('balance.available_credit', '10.00');
        $this->assertMatchesRegularExpression('/^[1-9]\d*$/', (string) $beforeRepeat->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $beforeRepeat->headers->get('X-Courses-Query-Count'));
        $this->patchJson("{$this->base}/groups/{$group['id']}/settings", [
            'revision' => $group['revision'], 'approved_price' => '180.00', 'completion_threshold' => 65,
            'instructor_ids' => array_column($group['instructors'], 'id'),
        ])->assertOk();
        $fresh = $this->getJson($url)->json();
        $repeatPayload = ['group_id' => $group['id'], 'group_revision' => $group['revision'] + 1,
            'currency_revision' => $fresh['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'repeated_from_attempt_id' => $first['id'],
            'version' => $fresh['student']['version'], 'request_id' => (string) Str::uuid()];
        $this->postJson($url, [...$repeatPayload, 'repeated_from_attempt_id' => null,
            'request_id' => (string) Str::uuid()])->assertConflict()->assertJsonPath('code', 'repeat_source_required');
        $this->postJson($url, [...$repeatPayload, 'joined_on' => '2026-09-27',
            'request_id' => (string) Str::uuid()])->assertUnprocessable();
        $repeat = $this->postJson($url, $repeatPayload)->assertCreated()
            ->assertJsonPath('attempt.fee.net_amount', '180.00')
            ->assertJsonPath('attempt.repeated_from_attempt_id', $first['id'])->json('attempt');
        $this->postJson($url, $repeatPayload)->assertOk()->assertJsonPath('attempt.id', $repeat['id']);
        $after = $this->getJson($url)->assertOk()->assertJsonCount(2, 'attempts')
            ->assertJsonPath('balance.debt', '250.00')
            ->assertJsonPath('balance.available_credit', '10.00');
        $older = collect($after->json('attempts'))->firstWhere('id', $first['id']);
        $newer = collect($after->json('attempts'))->firstWhere('id', $repeat['id']);
        $this->assertTrue($older['has_repeat']);
        $this->assertFalse($newer['has_repeat']);
        $this->assertSame('100.00', $older['fee']['net_amount']);
        $this->assertSame($closed['withdrawal']['withdrawn_on'], $older['withdrawal']['withdrawn_on']);
        $this->assertMatchesRegularExpression('/^[1-9]\d*$/', (string) $after->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $after->headers->get('X-Courses-Query-Count'));
        $this->postJson($url, [...$repeatPayload, 'version' => $after->json('student.version'), 'request_id' => (string) Str::uuid()])->assertConflict();
        $this->patchJson("{$this->base}/groups/{$group['id']}/settings", [
            'revision' => $group['revision'] + 1, 'approved_price' => '180.00', 'completion_threshold' => 95,
            'instructor_ids' => array_column($group['instructors'], 'id'),
        ])->assertOk();
        $this->center->run(function () use ($first, $repeat, $group): void {
            $this->assertSame(80, DB::table('study_attempts')->where('id', $first['id'])->value('completion_threshold'));
            $this->assertSame(65, DB::table('study_attempts')->where('id', $repeat['id'])->value('completion_threshold'));
            $this->assertSame(95, DB::table('study_groups')->where('id', $group['id'])->value('completion_threshold'));
            $this->assertSame(2, DB::table('study_attempt_fees')->count());
            $this->assertSame(1, DB::table('student_payments')->count());
            $this->assertSame(1, DB::table('student_payment_allocations')->count());
            $this->assertSame(1, DB::table('study_attempt_group_periods')->where('attempt_id', $repeat['id'])->whereNull('left_on')->count());
            $this->assertSame(1, DB::table('center_audit_logs')->where('event', 'student.study_withdrawn')->count());
            $this->assertSame(1, DB::table('center_audit_logs')->where('event', 'student.study_repeated')->count());
        });
        $auditUrls = ["{$this->base}/audit", "{$this->base}/branches/{$this->north}/audit"];
        $this->grant([$this->north => ['branch_auditor']]);
        $this->asUser($this->staff);
        foreach ($auditUrls as $auditUrl) {
            $hidden = $this->getJson($auditUrl)->assertOk()->getContent();
            $this->assertStringNotContainsString('student.study_withdrawn', $hidden);
            $this->assertStringNotContainsString('student.study_repeated', $hidden);
            $this->assertStringNotContainsString($withdrawal['reason'], $hidden);
        }
        $this->grant([$this->north => ['branch_auditor', 'registration']]);
        $this->asUser($this->staff);
        foreach ($auditUrls as $auditUrl) {
            $visible = $this->getJson($auditUrl)->assertOk()->getContent();
            $this->assertStringContainsString('student.study_withdrawn', $visible);
            $this->assertStringContainsString('student.study_repeated', $visible);
        }
    }

    public function test_repeat_of_legacy_unlinked_attempt_cannot_overlap_a_later_attempt(): void
    {
        $group = $this->group($this->north, '100.00');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $initial = $this->getJson($url)->json();
        $payload = ['group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $initial['student']['currency_revision'], 'discount' => '0.00',
            'discount_reason' => null];
        $first = $this->postJson($url, [...$payload, 'joined_on' => '2026-09-20',
            'version' => $initial['student']['version'], 'request_id' => (string) Str::uuid()])
            ->assertCreated()->json('attempt');
        $this->postJson("{$url}/{$first['id']}/withdraw", ['withdrawn_on' => '2026-09-21',
            'reason' => 'محاولة أولى منتهية', 'revision' => $first['revision'],
            'request_id' => (string) Str::uuid()])->assertOk();
        $afterFirst = $this->getJson($url)->json();
        $second = $this->postJson($url, [...$payload, 'joined_on' => '2026-09-22',
            'repeated_from_attempt_id' => $first['id'], 'version' => $afterFirst['student']['version'],
            'request_id' => (string) Str::uuid()])->assertCreated()->json('attempt');
        $this->postJson("{$url}/{$second['id']}/withdraw", ['withdrawn_on' => '2026-09-25',
            'reason' => 'محاولة ثانية منتهية', 'revision' => $second['revision'],
            'request_id' => (string) Str::uuid()])->assertOk();

        // Older attempts may predate the repeat lineage column and have no link.
        $this->center->run(fn () => DB::table('study_attempts')->where('id', $second['id'])
            ->update(['repeated_from_attempt_id' => null]));
        $fresh = $this->getJson($url)->json();
        $this->postJson($url, [...$payload, 'joined_on' => '2026-09-23',
            'repeated_from_attempt_id' => $first['id'], 'version' => $fresh['student']['version'],
            'request_id' => (string) Str::uuid()])->assertUnprocessable();
        $this->center->run(fn () => $this->assertSame(2, DB::table('study_attempts')->count()));
        $this->postJson($url, [...$payload, 'joined_on' => '2026-09-25',
            'repeated_from_attempt_id' => $first['id'], 'version' => $fresh['student']['version'],
            'request_id' => (string) Str::uuid()])->assertCreated();
    }

    public function test_fee_settlement_releases_excess_allocation_and_correction_preserves_original_entries(): void
    {
        $group = $this->group($this->north, '1000.00');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $enrollmentUrl = "{$this->base}/students/{$student['id']}/enrollments";
        $initial = $this->getJson($enrollmentUrl)->json();
        $attempt = $this->postJson($enrollmentUrl, [
            'group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $initial['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $initial['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $accountUrl = "{$this->base}/students/{$student['id']}/account";
        $payment = $this->postJson("{$this->base}/students/{$student['id']}/payments", [
            'branch_id' => $this->north, 'method' => 'cash', 'received_on' => '2026-09-28',
            'amount' => '900.00', 'version' => $this->getJson($accountUrl)->json('account.version'),
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('payment');
        $options = $this->getJson("{$this->base}/students/{$student['id']}/payments/{$payment['id']}/allocation-options")->json();
        $allocation = $this->postJson("{$this->base}/students/{$student['id']}/payments/{$payment['id']}/allocations", [
            'targets' => [['attempt_id' => $attempt['id'], 'amount' => '900.00']],
            'version' => $options['version'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('allocations.0');
        $this->postJson("{$enrollmentUrl}/{$attempt['id']}/withdraw", [
            'withdrawn_on' => '2026-09-28', 'reason' => 'انسحاب الطالب',
            'revision' => $attempt['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->getJson($accountUrl)->assertJsonPath('account.due_total', '1000.00')
            ->assertJsonPath('account.paid_total', '900.00');
        $url = "{$this->base}/students/{$student['id']}/fees/{$attempt['fee']['id']}/adjustments";
        $this->getJson("{$url}?new_due=1000.00")->assertUnprocessable();
        $preview = $this->getJson("{$url}?new_due=800.00")->assertOk()
            ->assertJsonPath('preview.fee_before', '1000.00')
            ->assertJsonPath('preview.account_after.due_total', '800.00')
            ->assertJsonPath('preview.account_after.paid_total', '800.00')
            ->assertJsonPath('preview.account_after.available_balance', '100.00')
            ->assertJsonPath('preview.account_after.debt', '0.00');
        $this->assertLessThanOrEqual(6, (int) $preview->headers->get('X-Courses-Query-Count'));
        $payload = ['new_due' => '800.00', 'reason' => 'تسوية معتمدة بعد الانسحاب',
            'replaces_adjustment_id' => null, 'version' => $preview->json('version'),
            'request_id' => (string) Str::uuid()];
        $settlement = $this->postJson($url, $payload)->assertCreated()->json('adjustments.0');
        $this->getJson($url)->assertOk()->assertJsonPath('latest_active_adjustment_id', $settlement['id']);
        $this->postJson($url, $payload)->assertOk()->assertJsonPath('adjustments.0.id', $settlement['id']);
        $this->postJson($url, [...$payload, 'new_due' => '700.00'])->assertConflict();
        $this->getJson($accountUrl)->assertOk()->assertJsonPath('account.due_total', '800.00')
            ->assertJsonPath('account.paid_total', '800.00')->assertJsonPath('account.available_balance', '100.00');
        $this->getJson($enrollmentUrl)->assertOk()->assertJsonPath('balance.debt', '0.00')
            ->assertJsonPath('attempts.0.fee.net_amount', '1000.00')
            ->assertJsonPath('attempts.0.fee.current_due', '800.00');
        $this->center->run(function () use ($attempt, $allocation): void {
            $this->assertSame('1000.00', DB::table('study_attempt_fees')->where('id', $attempt['fee']['id'])->value('net_amount'));
            $this->assertSame(1, DB::table('study_fee_adjustments')->count());
            $this->assertSame(1, DB::table('student_payment_allocation_reversals')->where('allocation_id', $allocation['id'])->count());
            $this->assertSame('800.00', ActiveStudentAllocations::query()
                ->where('allocations.fee_id', $attempt['fee']['id'])->value('allocations.amount'));
        });
        $fresh = $this->getJson($url)->json();
        $correction = ['new_due' => '1000.00', 'reason' => 'تصحيح تسوية أُدخلت خطأ',
            'replaces_adjustment_id' => $settlement['id'], 'version' => $fresh['version'],
            'request_id' => (string) Str::uuid()];
        $replacement = $this->postJson($url, $correction)->assertCreated()->assertJsonCount(2, 'adjustments')
            ->assertJsonPath('preview.account_after.due_total', '1000.00')
            ->assertJsonPath('preview.account_after.debt', '200.00')->json('adjustments.1');
        $olderPage = $this->getJson("{$url}?history_page=2")->assertOk()->assertJsonCount(0, 'history')
            ->assertJsonPath('latest_active_adjustment_id', $replacement['id']);
        $this->assertLessThanOrEqual(6, (int) $olderPage->headers->get('X-Courses-Query-Count'));
        $this->postJson($url, [...$correction, 'request_id' => (string) Str::uuid()])->assertConflict();
        $this->center->run(function () use ($settlement): void {
            $this->assertSame(3, DB::table('study_fee_adjustments')->count());
            $this->assertSame(1, DB::table('study_fee_adjustments')->where('reverses_id', $settlement['id'])->count());
            try {
                DB::table('study_fee_adjustments')->where('id', $settlement['id'])->update(['reason' => 'تغيير صامت']);
                $this->fail('Approved adjustments must be immutable.');
            } catch (QueryException $exception) {
                $this->assertStringContainsString('immutable', $exception->getMessage());
            }
            try {
                (require database_path('migrations/tenant/2026_09_28_203405_create_study_fee_adjustments.php'))->down();
                $this->fail('Rollback must preserve approved adjustments.');
            } catch (\RuntimeException $exception) {
                $this->assertStringContainsString('Cannot roll back', $exception->getMessage());
            }
        });
    }

    public function test_fee_settlement_requires_financial_approval_and_hides_other_branches(): void
    {
        $northGroup = $this->group($this->north, '100.00');
        $southGroup = $this->group($this->south, '200.00');
        $student = $this->student([$this->north, $this->south]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $first = $this->getJson($url)->json();
        $north = $this->postJson($url, [
            'group_id' => $northGroup['id'], 'group_revision' => $northGroup['revision'],
            'currency_revision' => $first['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $first['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $second = $this->getJson($url)->json();
        $south = $this->postJson($url, [
            'group_id' => $southGroup['id'], 'group_revision' => $southGroup['revision'],
            'currency_revision' => $second['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $second['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $northPath = "{$this->base}/students/{$student['id']}/fees/{$north['fee']['id']}/adjustments";
        $southPath = "{$this->base}/students/{$student['id']}/fees/{$south['fee']['id']}/adjustments";
        $this->grant([$this->north => ['accounting']]);
        $this->asUser($this->staff);
        $visible = $this->getJson($northPath)->assertOk()->assertJsonPath('can_approve', false);
        $this->getJson("{$northPath}?new_due=50.00")->assertForbidden();
        $this->getJson($southPath)->assertNotFound();
        $this->getJson("{$this->base}/students/{$student['id']}/account")->assertJsonCount(1, 'fees')
            ->assertJsonPath('fees.0.id', $north['fee']['id']);
        $this->postJson($northPath, ['new_due' => '50.00', 'reason' => 'قرار غير مصرح',
            'replaces_adjustment_id' => null, 'version' => $visible->json('version'),
            'request_id' => (string) Str::uuid()])->assertForbidden();
        $this->grant([$this->north => ['accounting', 'financial_approval']]);
        $this->asUser($this->staff);
        $preview = $this->getJson("{$northPath}?new_due=50.00")->assertOk()->assertJsonPath('can_approve', true);
        $this->assertLessThanOrEqual(6, (int) $preview->headers->get('X-Courses-Query-Count'));
        $approvedPayload = ['new_due' => '50.00', 'reason' => 'قرار مالي صريح',
            'replaces_adjustment_id' => null, 'version' => $preview->json('version'),
            'request_id' => (string) Str::uuid()];
        $approved = $this->postJson($northPath, $approvedPayload)->assertCreated()->json('adjustments.0');
        $this->grant([$this->north => ['accounting']]);
        $this->asUser($this->staff);
        $this->postJson($northPath, $approvedPayload)->assertOk()
            ->assertJsonPath('adjustments.0.id', $approved['id']);
        $this->postJson($northPath, [...$approvedPayload, 'request_id' => (string) Str::uuid()])->assertForbidden();
        $this->getJson($southPath)->assertNotFound();
        $this->center->run(fn () => $this->assertSame(1, DB::table('center_audit_logs')
            ->where('event', 'student.fee_settled')->where('branch_id', $this->north)->count()));
    }

    public function test_waitlist_reattachment_preserves_an_explicit_fee_settlement(): void
    {
        $first = $this->group($this->north, '150.00');
        $second = $this->postJson("{$this->base}/groups", [
            'level_id' => $first['level_id'], 'plan_version_id' => $first['plan_version_id'],
            'name' => 'Group after waitlist', 'approved_price' => '200.00',
            'instructor_ids' => array_column($first['instructors'], 'id'), 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $enrollmentUrl = "{$this->base}/students/{$student['id']}/enrollments";
        $initial = $this->getJson($enrollmentUrl)->json();
        $attempt = $this->postJson($enrollmentUrl, [
            'group_id' => $first['id'], 'group_revision' => $first['revision'],
            'currency_revision' => $initial['student']['currency_revision'], 'joined_on' => '2026-09-27',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $initial['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $waitUrl = "{$enrollmentUrl}/{$attempt['id']}/waitlist";
        $this->postJson($waitUrl, ['entered_on' => '2026-09-28', 'reason' => 'بانتظار موعد آخر',
            'revision' => $attempt['revision'], 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->getJson("{$this->base}/students/{$student['id']}/account")
            ->assertJsonPath('account.due_total', '150.00');
        $feeUrl = "{$this->base}/students/{$student['id']}/fees/{$attempt['fee']['id']}/adjustments";
        $preview = $this->getJson("{$feeUrl}?new_due=80.00")->assertOk()->json();
        $this->postJson($feeUrl, ['new_due' => '80.00', 'reason' => 'معالجة مالية مستقلة عن الانتظار',
            'replaces_adjustment_id' => null, 'version' => $preview['version'],
            'request_id' => (string) Str::uuid()])->assertCreated();
        $waiting = $this->getJson($enrollmentUrl)->assertJsonPath('attempts.0.current_group_id', null)
            ->assertJsonPath('attempts.0.fee.current_due', '80.00')->json();
        $this->postJson("{$enrollmentUrl}/{$attempt['id']}/reattach", [
            'group_id' => $second['id'], 'group_revision' => $second['revision'],
            'joined_on' => '2026-09-28', 'revision' => $waiting['attempts'][0]['revision'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->getJson($enrollmentUrl)->assertJsonPath('attempts.0.id', $attempt['id'])
            ->assertJsonPath('attempts.0.fee.id', $attempt['fee']['id'])
            ->assertJsonPath('attempts.0.fee.net_amount', '150.00')
            ->assertJsonPath('attempts.0.fee.current_due', '80.00')
            ->assertJsonPath('balance.debt', '80.00');
        $this->center->run(function (): void {
            $this->assertSame(1, DB::table('study_attempts')->count());
            $this->assertSame(1, DB::table('study_attempt_fees')->count());
            $this->assertSame(1, DB::table('study_fee_adjustments')->count());
        });
    }

    public function test_repeat_lineage_prevents_rollback_even_without_a_withdrawal(): void
    {
        $group = $this->group($this->north, '0.00');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $initial = $this->getJson($url)->json();
        $first = $this->postJson($url, [
            'group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $initial['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $initial['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $this->center->run(function () use ($first): void {
            DB::table('study_attempts')->where('id', $first['id'])->update(['status' => 'completed']);
            DB::table('study_attempt_group_periods')->where('attempt_id', $first['id'])->update(['left_on' => '2026-09-28']);
        });
        $fresh = $this->getJson($url)->json();
        $this->postJson($url, [
            'group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $fresh['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'repeated_from_attempt_id' => $first['id'],
            'version' => $fresh['student']['version'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->center->run(function (): void {
            $this->assertSame(0, DB::table('study_attempt_withdrawals')->count());
            try {
                (require database_path('migrations/tenant/2026_09_28_180622_add_study_attempt_withdrawals_and_repeats.php'))->down();
                $this->fail('A rollback must preserve approved repeat lineage.');
            } catch (\RuntimeException $exception) {
                $this->assertStringContainsString('withdrawals or repeats', $exception->getMessage());
            }
            $this->assertTrue(DB::getSchemaBuilder()->hasColumn('study_attempts', 'repeated_from_attempt_id'));
        });
    }

    public function test_withdrawal_accepts_the_current_cairo_date_after_utc_midnight_boundary(): void
    {
        $group = $this->group($this->north, '0.00');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $workspace = $this->getJson($url)->json();
        $attempt = $this->postJson($url, [
            'group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $workspace['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $workspace['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');

        $this->travelTo(new \DateTimeImmutable('2026-09-28 22:30:00 UTC'));
        $withdrawUrl = "{$url}/{$attempt['id']}/withdraw";
        $payload = ['withdrawn_on' => '2026-09-29', 'reason' => 'انتهاء الدراسة اليوم',
            'revision' => $attempt['revision'], 'request_id' => (string) Str::uuid()];
        $this->postJson($withdrawUrl, [...$payload, 'withdrawn_on' => '2026-09-30',
            'request_id' => (string) Str::uuid()])->assertUnprocessable();
        $this->postJson($withdrawUrl, $payload)->assertOk()
            ->assertJsonPath('attempt.withdrawal.withdrawn_on', '2026-09-29');
        $this->travelBack();
    }

    public function test_withdrawal_cannot_move_a_recorded_attendance_outside_the_study_period(): void
    {
        $group = $this->group($this->north, '0.00');
        $student = $this->student([$this->north]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $workspace = $this->getJson($url)->json();
        $attempt = $this->postJson($url, [
            'group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $workspace['student']['currency_revision'], 'joined_on' => '2026-09-26',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $workspace['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $sessionId = (string) Str::uuid();
        $entryId = (string) Str::uuid();
        $this->center->run(function () use ($group, $attempt, $sessionId, $entryId): void {
            $lectureId = DB::table('plan_lectures')->where('plan_version_id', $group['plan_version_id'])->value('id');
            DB::table('study_sessions')->insert([
                'id' => $sessionId, 'group_id' => $group['id'], 'plan_lecture_id' => $lectureId,
                'number' => 1, 'scheduled_at' => '2026-09-28 10:00:00+00', 'status' => 'held',
                'created_by' => $this->owner->id, 'created_by_name' => $this->owner->name,
                'created_at' => now(), 'updated_at' => now(),
            ]);
            DB::table('study_attendance_entries')->insert([
                'id' => $entryId, 'session_id' => $sessionId, 'attempt_id' => $attempt['id'],
                'status' => 'counted', 'recorded_by' => $this->owner->id, 'recorded_at' => now(),
                'created_at' => now(), 'updated_at' => now(),
            ]);
        });
        $noteUrl = "{$this->base}/groups/{$group['id']}/sessions/{$sessionId}/attendance/{$entryId}/note";
        $this->putJson($noteUrl, [
            'body' => 'حضور محفوظ قبل الانسحاب', 'important' => true,
            'revision' => 0, 'entry_revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->assertJsonPath('note.revision', 1);
        $this->travelTo(new \DateTimeImmutable('2026-09-29 10:00:00 UTC'));
        $withdrawUrl = "{$url}/{$attempt['id']}/withdraw";
        $payload = ['withdrawn_on' => '2026-09-27', 'reason' => 'انسحاب مؤرخ',
            'revision' => $attempt['revision'], 'request_id' => (string) Str::uuid()];
        $this->postJson($withdrawUrl, $payload)->assertUnprocessable();
        $this->postJson($withdrawUrl, [...$payload, 'withdrawn_on' => '2026-09-28',
            'request_id' => (string) Str::uuid()])->assertUnprocessable();
        $this->postJson($withdrawUrl, [...$payload, 'withdrawn_on' => '2026-09-29',
            'request_id' => (string) Str::uuid()])->assertOk()->assertJsonPath('attempt.status', 'withdrawn');
        $this->getJson($noteUrl)->assertOk()->assertJsonPath('note.body', 'حضور محفوظ قبل الانسحاب')
            ->assertJsonPath('note.important', true)->assertJsonPath('versions.0.revision', 1);
        $this->travelBack();
    }

    public function test_withdrawal_requires_current_branch_grant_and_audit_failure_rolls_back(): void
    {
        $group = $this->group($this->north, '0.00');
        $student = $this->student([$this->north, $this->south]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $workspace = $this->getJson($url)->json();
        $attempt = $this->postJson($url, ['group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $workspace['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $workspace['student']['version'],
            'request_id' => (string) Str::uuid()])->assertCreated()->json('attempt');
        $withdrawUrl = "{$url}/{$attempt['id']}/withdraw";
        $payload = ['withdrawn_on' => '2026-09-28', 'reason' => 'قرار موثق', 'revision' => 1, 'request_id' => (string) Str::uuid()];
        $this->grant([$this->south => ['registration']]);
        $this->asUser($this->staff);
        $this->getJson($url)->assertJsonCount(0, 'attempts');
        $this->postJson($withdrawUrl, $payload)->assertNotFound();
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT withdrawal_audit_failure CHECK (event <> 'student.study_withdrawn') NOT VALID"));
        try {
            $this->postJson($withdrawUrl, $payload)->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT withdrawal_audit_failure'));
        }
        $this->center->run(function () use ($attempt): void {
            $this->assertSame('active', DB::table('study_attempts')->where('id', $attempt['id'])->value('status'));
            $this->assertNull(DB::table('study_attempt_group_periods')->where('attempt_id', $attempt['id'])->value('left_on'));
            $this->assertSame(0, DB::table('study_attempt_withdrawals')->count());
        });
        $this->postJson($withdrawUrl, $payload)->assertOk();
        $this->grant([$this->south => ['registration']]);
        $this->asUser($this->staff);
        $this->postJson($withdrawUrl, $payload)->assertNotFound();
    }

    public function test_transferred_attempt_uses_current_branch_for_withdrawal_and_original_branch_for_fee_event(): void
    {
        $group = $this->group($this->north, '100.00');
        $student = $this->student([$this->north, $this->south]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $workspace = $this->getJson($url)->json();
        $attempt = $this->postJson($url, ['group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $workspace['student']['currency_revision'], 'joined_on' => '2026-09-28',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $workspace['student']['version'],
            'request_id' => (string) Str::uuid()])->assertCreated()->json('attempt');
        // Model a branch transfer while keeping the original fee event in its recorded branch.
        $this->center->run(fn () => DB::table('study_attempts')->where('id', $attempt['id'])->update(['branch_id' => $this->south]));
        $this->grant([$this->south => ['registration']]);
        $this->asUser($this->staff);
        $this->getJson($url)->assertOk()->assertJsonCount(1, 'attempts')
            ->assertJsonPath('attempts.0.branch_id', $this->south)
            ->assertJsonPath('attempts.0.event_branch_id', null)
            ->assertJsonPath('attempts.0.fee', null);
        $this->postJson("{$url}/{$attempt['id']}/withdraw", [
            'withdrawn_on' => '2026-09-28', 'reason' => 'انسحاب بعد النقل', 'revision' => 1,
            'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('attempt.status', 'withdrawn');
    }

    public function test_transfer_rechecks_approved_coverage_and_preserves_source_money_attendance_and_privacy(): void
    {
        $source = $this->group($this->north, '100.00');
        $target = $this->group($this->south, '250.00');
        $secondTarget = $this->postJson("{$this->base}/groups", [
            'level_id' => $target['level_id'], 'plan_version_id' => $target['plan_version_id'],
            'name' => 'South second', 'approved_price' => '250.00',
            'instructor_ids' => array_column($target['instructors'], 'id'), 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $student = $this->student([$this->north, $this->south]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $workspace = $this->getJson($url)->assertOk()->json();
        $attempt = $this->postJson($url, [
            'group_id' => $source['id'], 'group_revision' => $source['revision'],
            'currency_revision' => $workspace['student']['currency_revision'], 'joined_on' => '2026-09-26',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $workspace['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $this->center->run(function () use ($attempt, $student): void {
            $submissionId = (string) Str::uuid();
            DB::table('study_fee_adjustment_submissions')->insert([
                'request_id' => $submissionId, 'student_id' => $student['id'], 'fee_id' => $attempt['fee']['id'],
                'kind' => 'settle', 'request_hash' => hash('sha256', $submissionId), 'actor_id' => $this->owner->id,
                'created_at' => now(),
            ]);
            DB::table('study_fee_adjustments')->insert([
                'id' => (string) Str::uuid(), 'submission_id' => $submissionId, 'sequence' => 1,
                'student_id' => $student['id'], 'fee_id' => $attempt['fee']['id'], 'branch_id' => $this->north,
                'kind' => 'settlement', 'amount_delta' => '-20.00', 'before_due' => '100.00',
                'after_due' => '80.00', 'reason' => 'تسوية قبل النقل', 'actor_id' => $this->owner->id,
                'actor_name' => $this->owner->name, 'created_at' => now(),
            ]);
        });
        $sourceLecture = $this->center->run(fn () => DB::table('plan_lectures')->where('plan_version_id', $source['plan_version_id'])->value('id'));
        $targetLecture = $this->center->run(fn () => DB::table('plan_lectures')->where('plan_version_id', $target['plan_version_id'])->value('id'));
        $sessionId = (string) Str::uuid();
        $this->center->run(function () use ($source, $attempt, $sourceLecture, $sessionId): void {
            DB::table('study_sessions')->insert(['id' => $sessionId, 'group_id' => $source['id'],
                'plan_lecture_id' => $sourceLecture, 'number' => 1, 'scheduled_at' => '2026-09-27 08:00:00+00',
                'status' => 'planned',
                'created_by' => $this->owner->id, 'created_by_name' => $this->owner->name,
                'created_at' => now(), 'updated_at' => now()]);
            DB::table('study_attendance_entries')->insert(['id' => (string) Str::uuid(), 'session_id' => $sessionId,
                'attempt_id' => $attempt['id'], 'status' => 'counted', 'recorded_by' => $this->owner->id,
                'recorded_at' => now(), 'created_at' => now(), 'updated_at' => now()]);
            $cancelledId = (string) Str::uuid();
            DB::table('study_sessions')->insert(['id' => $cancelledId, 'group_id' => $source['id'],
                'plan_lecture_id' => $sourceLecture, 'number' => 2, 'scheduled_at' => '2026-09-28 08:00:00+00',
                'status' => 'cancelled', 'closed_at' => now(), 'closed_by' => $this->owner->id,
                'created_by' => $this->owner->id, 'created_by_name' => $this->owner->name,
                'created_at' => now(), 'updated_at' => now()]);
            DB::table('study_attendance_entries')->insert(['id' => (string) Str::uuid(), 'session_id' => $cancelledId,
                'attempt_id' => $attempt['id'], 'status' => 'counted', 'recorded_by' => $this->owner->id,
                'recorded_at' => now(), 'created_at' => now(), 'updated_at' => now()]);
        });
        $transferUrl = "{$url}/{$attempt['id']}/transfer";
        $previewUrl = "{$transferUrl}/preview?".http_build_query(['group_id' => $target['id'], 'transferred_on' => '2026-09-28']);
        $beforeApproval = $this->getJson($previewUrl)->assertOk()->assertJsonPath('preview.equivalence_ready', false)
            ->assertJsonPath('preview.credited_count', 0)->json('preview');
        $this->postJson("{$this->base}/content-equivalences", [
            'source_plan_version_id' => $source['plan_version_id'], 'target_plan_version_id' => $target['plan_version_id'],
            'source_lecture_ids' => [$sourceLecture], 'target_lecture_ids' => [$targetLecture],
            'reason' => 'اعتماد محتوى المحاضرة كاملة', 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $previewResponse = $this->getJson($previewUrl)->assertOk()->assertJsonPath('preview.equivalence_ready', true)
            ->assertJsonPath('preview.credited_count', 1)->assertJsonPath('preview.required_count', 1)
            ->assertJsonPath('preview.balance.debt', '80.00');
        $this->assertLessThanOrEqual(6, (int) $previewResponse->headers->get('X-Courses-Query-Count'));
        $preview = $previewResponse->json('preview');
        $this->assertSame([['id' => $targetLecture, 'number' => 1, 'final' => false]], $preview['credited_lectures']);
        $this->assertSame([1], $preview['open_credited_numbers']);
        $this->assertSame([], $preview['missing_lectures']);
        $payload = ['group_id' => $target['id'], 'group_revision' => $target['revision'],
            'transferred_on' => '2026-09-28', 'revision' => $attempt['revision'],
            'preview_hash' => $beforeApproval['hash'], 'reason' => 'نقل للفرع الجنوبي', 'request_id' => (string) Str::uuid()];
        $this->postJson($transferUrl, $payload)->assertConflict()->assertJsonPath('code', 'transfer_preview_changed');
        $this->patchJson("{$this->base}/levels/{$target['level_id']}/completion-threshold", [
            'revision' => 1, 'completion_threshold' => 75,
        ])->assertOk();
        $this->postJson($transferUrl, [...$payload, 'preview_hash' => $preview['hash'],
            'request_id' => (string) Str::uuid()])->assertConflict()->assertJsonPath('code', 'transfer_preview_changed');
        $thresholdPreview = $this->getJson($previewUrl)->assertOk()
            ->assertJsonPath('preview.to.completion_threshold', 75)->json('preview');
        $this->center->run(fn () => DB::table('students')->where('id', $student['id'])
            ->increment('financial_account_revision'));
        $this->postJson($transferUrl, [...$payload, 'preview_hash' => $thresholdPreview['hash'],
            'request_id' => (string) Str::uuid()])->assertConflict()->assertJsonPath('code', 'transfer_preview_changed');
        $openPreview = $this->getJson($previewUrl)->assertOk()->assertJsonPath('preview.open_credited_numbers', [1])->json('preview');
        $this->center->run(fn () => DB::table('study_sessions')->where('id', $sessionId)->update([
            'status' => 'held', 'closed_at' => now(), 'closed_by' => $this->owner->id,
        ]));
        $this->postJson($transferUrl, [...$payload, 'preview_hash' => $openPreview['hash'],
            'request_id' => (string) Str::uuid()])->assertConflict()->assertJsonPath('code', 'transfer_preview_changed');
        $payload['preview_hash'] = $this->getJson($previewUrl)->assertOk()
            ->assertJsonPath('preview.open_credited_numbers', [])->json('preview.hash');
        $payload['request_id'] = (string) Str::uuid();
        $this->grant([$this->north => ['registration'], $this->south => ['registration']]);
        $this->asUser($this->staff);
        $this->postJson($transferUrl, $payload)->assertCreated()->assertJsonPath('transfer.attempt_id', $attempt['id'])
            ->assertJsonPath('transfer.credited_lectures.0.id', $targetLecture)
            ->assertJsonPath('transfer.missing_lectures', []);
        $this->postJson($transferUrl, $payload)->assertOk()->assertJsonPath('replayed', true);
        $this->postJson($transferUrl, [...$payload, 'reason' => 'سبب مختلف'])->assertConflict()
            ->assertJsonPath('code', 'transfer_request_changed');
        $this->grant([$this->south => ['registration']]);
        $this->postJson($transferUrl, $payload)->assertNotFound();
        $this->asUser($this->owner);
        $this->getJson($url)->assertOk()->assertJsonPath('attempts.0.id', $attempt['id'])
            ->assertJsonPath('attempts.0.branch_id', $this->south)
            ->assertJsonPath('attempts.0.current_group_id', $target['id'])
            ->assertJsonPath('attempts.0.fee.net_amount', '100.00');
        $coverage = $this->getJson("{$this->base}/groups/{$target['id']}/coverage")
            ->assertOk()->assertJsonPath('students.0.covered_count', 1)->assertJsonPath('students.0.missing_numbers', []);
        $this->assertLessThanOrEqual(6, (int) $coverage->headers->get('X-Courses-Query-Count'));
        $thresholdGroup = $this->patchJson("{$this->base}/groups/{$target['id']}/settings", [
            'revision' => $target['revision'], 'approved_price' => '250.00',
            'completion_threshold' => 60, 'instructor_ids' => array_column($target['instructors'], 'id'),
        ])->assertOk()->json('group');
        $thresholdPath = "{$this->base}/groups/{$target['id']}/completion-threshold";
        $thresholdChange = ['attempt_ids' => [$attempt['id']], 'reason' => 'اعتماد الحد الجديد بعد تغطية منقولة'];
        $thresholdImpact = $this->postJson("{$thresholdPath}/preview", $thresholdChange)->assertOk()
            ->assertJsonPath('students.0.covered_count', 1)
            ->assertJsonPath('students.0.open_credited_count', 0)
            ->assertJsonPath('students.0.before_provisional', false)
            ->assertJsonPath('students.0.after_provisional', false)
            ->assertJsonPath('students.0.before_threshold', 75)
            ->assertJsonPath('students.0.after_threshold', 60)->json();
        $this->postJson($thresholdPath, [...$thresholdChange,
            'preview_token' => $thresholdImpact['preview_token'], 'request_id' => (string) Str::uuid()])
            ->assertOk()->assertJsonPath('students.0.covered_count', 1);
        $this->patchJson("{$this->base}/groups/{$target['id']}/settings", [
            'revision' => $thresholdGroup['revision'], 'approved_price' => '250.00',
            'completion_threshold' => 80, 'instructor_ids' => array_column($target['instructors'], 'id'),
        ])->assertOk();
        $staleChange = ['attempt_ids' => [$attempt['id']], 'reason' => 'رفع الحد بعد نقل التغطية'];
        $staleImpact = $this->postJson("{$thresholdPath}/preview", $staleChange)->assertOk()
            ->assertJsonPath('students.0.covered_count', 1)->json();
        $sourceSessionPath = "{$this->base}/groups/{$source['id']}/sessions/{$sessionId}";
        $revokePreview = $this->getJson("{$sourceSessionPath}/revoke-preview")->assertOk()
            ->assertJsonPath('attendance.potential_coverage_records', 1)->json();
        $this->postJson("{$sourceSessionPath}/revoke", [
            'reason' => 'إلغاء اعتماد مصدر التغطية المنقولة',
            'session_revision' => $revokePreview['session_revision'],
            'group_revision' => $revokePreview['group_revision'],
            'preview_token' => $revokePreview['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->postJson($thresholdPath, [...$staleChange,
            'preview_token' => $staleImpact['preview_token'], 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'threshold_preview_changed');
        $this->getJson("{$this->base}/groups/{$target['id']}/coverage")
            ->assertOk()->assertJsonPath('students.0.covered_count', 0);
        $this->center->run(function () use ($attempt, $target): void {
            $this->assertSame(1, DB::table('study_attempt_transfers')->where('attempt_id', $attempt['id'])->count());
            $this->assertSame(1, DB::table('study_attempt_fees')->where('attempt_id', $attempt['id'])->count());
            $this->assertSame(1, DB::table('study_fee_adjustments')->where('fee_id', $attempt['fee']['id'])->count());
            $this->assertSame($this->north, (int) DB::table('study_attempt_fees')->where('attempt_id', $attempt['id'])->value('branch_id'));
            $this->assertSame(2, DB::table('study_attendance_entries')->where('attempt_id', $attempt['id'])->count());
            $this->assertSame(2, DB::table('study_attempt_group_periods')->where('attempt_id', $attempt['id'])->count());
            $this->assertSame(1, DB::table('study_attempt_group_periods')->where('attempt_id', $attempt['id'])->whereNull('left_on')->count());
            $this->assertSame($target['plan_version_id'], DB::table('study_attempts')->where('id', $attempt['id'])->value('plan_version_id'));
            $this->assertSame(2, DB::table('center_audit_logs')->where('event', 'student.study_transferred')->count());
            try {
                (require database_path('migrations/tenant/2026_09_29_000100_add_study_transfer_coverage_snapshot.php'))->down();
                $this->fail('Rollback must preserve transfer coverage snapshots.');
            } catch (\RuntimeException $exception) {
                $this->assertStringContainsString('Cannot roll back', $exception->getMessage());
            }
        });
        $this->grant([$this->north => ['branch_auditor', 'registration'], $this->south => ['branch_auditor', 'registration']]);
        $this->asUser($this->staff);
        $this->assertSame(2, collect($this->getJson("{$this->base}/audit")->assertOk()->json('entries'))
            ->where('event', 'student.study_transferred')->count());
        $this->asUser($this->owner);
        $this->center->run(function () use ($attempt): void {
            $saved = (array) DB::table('study_attempt_transfers')->where('attempt_id', $attempt['id'])->firstOrFail();
            $rows = [];
            for ($index = 1; $index <= 21; $index++) {
                $rows[] = [...$saved, 'id' => (string) Str::uuid(), 'request_id' => (string) Str::uuid(),
                    'created_at' => now()->addSeconds($index)];
            }
            DB::table('study_attempt_transfers')->insert($rows);
        });
        $historyUrl = "{$transferUrl}/preview?".http_build_query([
            'group_id' => $secondTarget['id'], 'transferred_on' => '2026-09-29',
        ]);
        $firstHistory = $this->getJson($historyUrl)->assertOk()->assertJsonPath('history_page', 1)
            ->assertJsonPath('history_has_more', true)->assertJsonCount(20, 'history')->json('history');
        $lastHistory = $this->getJson($historyUrl.'&history_page=2')->assertOk()
            ->assertJsonPath('history_page', 2)->assertJsonPath('history_has_more', false)
            ->assertJsonCount(2, 'history')->json('history');
        $this->assertEmpty(array_intersect(array_column($firstHistory, 'id'), array_column($lastHistory, 'id')));
        $this->grant([$this->south => ['registration']]);
        $this->asUser($this->staff);
        $this->getJson($url)->assertOk()->assertJsonPath('attempts.0.fee', null)
            ->assertJsonPath('attempts.0.event_branch_id', null);
        $this->getJson("{$transferUrl}/preview?".http_build_query([
            'group_id' => $source['id'], 'transferred_on' => '2026-09-29',
        ]))->assertNotFound();
        $hiddenHistory = $this->getJson("{$transferUrl}/preview?".http_build_query([
            'group_id' => $secondTarget['id'], 'transferred_on' => '2026-09-29',
        ]))->assertOk()->assertJsonCount(0, 'history');
        $this->assertLessThanOrEqual(6, (int) $hiddenHistory->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$transferUrl}/history")->assertOk()->assertJsonCount(0, 'history');
        $this->asUser($this->owner);
        $current = $this->getJson($url)->assertOk()->json('attempts.0');
        $this->postJson("{$url}/{$attempt['id']}/withdraw", [
            'withdrawn_on' => '2026-09-29', 'reason' => 'انسحاب بعد النقل',
            'revision' => $current['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('attempt.status', 'withdrawn');
        $this->getJson("{$transferUrl}/preview?".http_build_query([
            'group_id' => $secondTarget['id'], 'transferred_on' => '2026-09-29',
        ]))->assertStatus(409);
        $closedHistory = $this->getJson("{$transferUrl}/history?history_page=2")->assertOk()
            ->assertJsonPath('history_page', 2)->assertJsonCount(2, 'history');
        $this->assertLessThanOrEqual(6, (int) $closedHistory->headers->get('X-Courses-Query-Count'));
    }

    public function test_waitlisted_attempt_moves_to_a_different_plan_only_with_current_permissions(): void
    {
        $source = $this->group($this->north, '75.00');
        $target = $this->group($this->south, '175.00');
        $student = $this->student([$this->north, $this->south]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $workspace = $this->getJson($url)->assertOk()->json();
        $attempt = $this->postJson($url, [
            'group_id' => $source['id'], 'group_revision' => $source['revision'],
            'currency_revision' => $workspace['student']['currency_revision'], 'joined_on' => '2026-09-26',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $workspace['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $waiting = $this->postJson("{$url}/{$attempt['id']}/waitlist", [
            'entered_on' => '2026-09-28', 'reason' => 'انتظار وجهة أخرى',
            'revision' => $attempt['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('waitlist');
        $sourceLecture = $this->center->run(fn () => DB::table('plan_lectures')->where('plan_version_id', $source['plan_version_id'])->value('id'));
        $targetLecture = $this->center->run(fn () => DB::table('plan_lectures')->where('plan_version_id', $target['plan_version_id'])->value('id'));
        $this->postJson("{$this->base}/content-equivalences", [
            'source_plan_version_id' => $source['plan_version_id'], 'target_plan_version_id' => $target['plan_version_id'],
            'source_lecture_ids' => [$sourceLecture], 'target_lecture_ids' => [$targetLecture],
            'reason' => 'معادلة الخطة للوجهة الجديدة', 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->grant([$this->north => ['registration'], $this->south => ['registration']]);
        $this->asUser($this->staff);
        $transferUrl = "{$url}/{$attempt['id']}/transfer";
        $preview = $this->getJson("{$transferUrl}/preview?".http_build_query([
            'group_id' => $target['id'], 'transferred_on' => '2026-09-29',
        ]))->assertOk()->assertJsonPath('preview.equivalence_ready', true)->json('preview');
        $payload = ['group_id' => $target['id'], 'group_revision' => $target['revision'],
            'transferred_on' => '2026-09-29', 'revision' => $preview['revision'],
            'preview_hash' => $preview['hash'], 'reason' => 'إلحاق المنتظر بوجهة أخرى',
            'request_id' => (string) Str::uuid()];
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $this->postJson($transferUrl, $payload)->assertNotFound();
        $this->grant([$this->north => ['registration'], $this->south => ['registration']]);
        $this->asUser($this->staff);
        $this->postJson($transferUrl, $payload)->assertCreated()->assertJsonPath('transfer.to.group_id', $target['id']);
        $this->getJson($url)->assertOk()->assertJsonPath('attempts.0.id', $attempt['id'])
            ->assertJsonPath('attempts.0.current_group_id', $target['id'])
            ->assertJsonPath('attempts.0.latest_waitlist', null);
        $this->center->run(function () use ($attempt, $waiting, $target): void {
            $this->assertSame($target['id'], DB::table('study_attempt_waitlists')->where('id', $waiting['id'])->value('to_group_id'));
            $this->assertSame('2026-09-29', DB::table('study_attempt_waitlists')->where('id', $waiting['id'])->value('left_on'));
            $this->assertSame(1, DB::table('study_attempt_group_periods')->where('attempt_id', $attempt['id'])->whereNull('left_on')->count());
            $this->assertSame(1, DB::table('study_attempt_fees')->where('attempt_id', $attempt['id'])->count());
            $this->assertSame(1, DB::table('study_attempt_transfers')->where('attempt_id', $attempt['id'])->count());
        });
        $this->grant([$this->south => ['registration']]);
        $this->asUser($this->staff);
        $this->getJson("{$url}/{$attempt['id']}/waitlist")->assertOk()->assertJsonCount(0, 'history');
        $this->getJson($url)->assertOk()->assertJsonPath('attempts.0.latest_waitlist', null)
            ->assertJsonPath('attempts.0.fee', null);
    }

    public function test_successive_transfers_carry_approved_coverage_into_the_final_plan(): void
    {
        $source = $this->group($this->north, '100.00');
        $middle = $this->group($this->south, '150.00');
        $target = $this->group($this->south, '200.00');
        $student = $this->student([$this->north, $this->south]);
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$student['id']}/enrollments";
        $workspace = $this->getJson($url)->assertOk()->json();
        $attempt = $this->postJson($url, [
            'group_id' => $source['id'], 'group_revision' => $source['revision'],
            'currency_revision' => $workspace['student']['currency_revision'], 'joined_on' => '2026-09-26',
            'discount' => '0.00', 'discount_reason' => null, 'version' => $workspace['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $lectures = $this->center->run(fn () => DB::table('plan_lectures')
            ->whereIn('plan_version_id', [$source['plan_version_id'], $middle['plan_version_id'], $target['plan_version_id']])
            ->pluck('id', 'plan_version_id')->all());
        [$sessionId, $entryId] = $this->center->run(function () use ($source, $attempt, $lectures): array {
            $sessionId = (string) Str::uuid();
            $entryId = (string) Str::uuid();
            DB::table('study_sessions')->insert(['id' => $sessionId, 'group_id' => $source['id'],
                'plan_lecture_id' => $lectures[$source['plan_version_id']], 'number' => 1,
                'scheduled_at' => '2026-09-27 08:00:00+00', 'status' => 'held', 'closed_at' => now(),
                'closed_by' => $this->owner->id, 'created_by' => $this->owner->id,
                'created_by_name' => $this->owner->name, 'created_at' => now(), 'updated_at' => now()]);
            DB::table('study_attendance_entries')->insert(['id' => $entryId,
                'session_id' => $sessionId, 'attempt_id' => $attempt['id'], 'status' => 'absent',
                'recorded_by' => $this->owner->id, 'recorded_at' => now(), 'created_at' => now(), 'updated_at' => now()]);

            return [$sessionId, $entryId];
        });
        foreach ([[$source, $middle], [$middle, $target]] as [$from, $to]) {
            $this->postJson("{$this->base}/content-equivalences", [
                'source_plan_version_id' => $from['plan_version_id'], 'target_plan_version_id' => $to['plan_version_id'],
                'source_lecture_ids' => [$lectures[$from['plan_version_id']]],
                'target_lecture_ids' => [$lectures[$to['plan_version_id']]],
                'reason' => 'معادلة النقل المتتابع', 'request_id' => (string) Str::uuid(),
            ])->assertCreated();
        }
        $transferUrl = "{$url}/{$attempt['id']}/transfer";
        foreach ([[$middle, '2026-09-28', 0], [$target, '2026-09-29', 1]] as [$destination, $date, $credited]) {
            $preview = $this->getJson("{$transferUrl}/preview?".http_build_query([
                'group_id' => $destination['id'], 'transferred_on' => $date,
            ]))->assertOk()->assertJsonPath('preview.credited_count', $credited)
                ->assertJsonPath('preview.equivalence_ready', true)->json('preview');
            if ($destination['id'] === $target['id']) {
                $this->assertSame(2, $preview['approval_count']);
            }
            $this->postJson($transferUrl, [
                'group_id' => $destination['id'], 'group_revision' => $destination['revision'],
                'transferred_on' => $date, 'revision' => $preview['revision'],
                'preview_hash' => $preview['hash'], 'reason' => 'نقل مع الاحتفاظ بالمحتسب',
                'request_id' => (string) Str::uuid(),
            ])->assertCreated()->assertJsonPath('transfer.credited_count', $credited);
            if ($destination['id'] === $middle['id']) {
                $this->center->run(fn () => $this->assertSame('[]', DB::table('study_attempt_transfers')
                    ->where('attempt_id', $attempt['id'])->value('approval_ids')));
                $this->center->run(fn () => $this->assertSame($lectures[$middle['plan_version_id']],
                    json_decode(DB::table('study_attempt_transfers')->where('attempt_id', $attempt['id'])
                        ->value('missing_lectures'), true)[0]['id']));
                $this->postJson("{$this->base}/groups/{$source['id']}/sessions/{$sessionId}/attendance/{$entryId}/correct", [
                    'status' => 'counted', 'reason' => 'تصحيح حضور قديم', 'revision' => 1,
                    'entry_revision' => 1, 'request_id' => (string) Str::uuid(),
                ])->assertOk();
                $this->getJson("{$this->base}/groups/{$middle['id']}/coverage")
                    ->assertOk()->assertJsonPath('students.0.covered_count', 1);
                $this->getJson("{$transferUrl}/history")->assertOk()
                    ->assertJsonPath('history.0.missing_lectures.0.id', $lectures[$middle['plan_version_id']]);
            }
        }
        $coverage = $this->getJson("{$this->base}/groups/{$target['id']}/coverage")
            ->assertOk()->assertJsonPath('students.0.covered_count', 1)
            ->assertJsonPath('students.0.missing_numbers', [])->assertJsonPath('students.0.open_numbers', []);
        $this->assertLessThanOrEqual(6, (int) $coverage->headers->get('X-Courses-Query-Count'));
        $this->center->run(fn () => $this->assertSame(2,
            DB::table('study_attempt_transfers')->where('attempt_id', $attempt['id'])->count()));
        $this->center->run(fn () => $this->assertCount(2, json_decode(DB::table('study_attempt_transfers')
            ->where('attempt_id', $attempt['id'])->where('to_group_id', $target['id'])->value('approval_ids'), true)));
        $this->getJson("{$transferUrl}/history")->assertOk()
            ->assertJsonPath('history.0.credited_lectures.0.id', $lectures[$target['plan_version_id']])
            ->assertJsonPath('history.1.missing_lectures.0.id', $lectures[$middle['plan_version_id']]);
    }

    public function test_transfer_migration_reaches_existing_and_new_centers(): void
    {
        $this->center->run(function (): void {
            DB::statement('DROP TABLE study_attempt_transfers');
            DB::statement('DROP INDEX content_equivalences_target_plan_idx');
            DB::table('migrations')->whereIn('migration', [
                '2026_09_29_000000_create_study_attempt_transfers',
                '2026_09_29_000100_add_study_transfer_coverage_snapshot',
                '2026_09_29_000200_index_content_equivalence_target_plan',
            ])->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->center->run(function (): void {
            $this->assertTrue(DB::getSchemaBuilder()->hasTable('study_attempt_transfers'));
            $this->assertTrue(DB::getSchemaBuilder()->hasColumn('study_attempt_transfers', 'credited_lectures'));
            $this->assertTrue(DB::table('pg_indexes')->where('indexname', 'content_equivalences_target_plan_idx')->exists());
        });
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')
            ->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => 'Beta', 'slug' => 'beta', 'subdomain' => 'beta', 'plan' => 'starter', 'owner_email' => 'owner@beta.test',
            ])->assertCreated();
        Center::where('slug', 'beta')->firstOrFail()->run(
            function (): void {
                $this->assertTrue(DB::getSchemaBuilder()->hasTable('study_attempt_transfers'));
                $this->assertTrue(DB::getSchemaBuilder()->hasColumn('study_attempt_transfers', 'missing_lectures'));
                $this->assertTrue(DB::table('pg_indexes')->where('indexname', 'content_equivalences_target_plan_idx')->exists());
            });
    }

    private function group(int $branchId, string $price, int $lectureCount = 1): array
    {
        $course = $this->postJson("{$this->base}/courses", ['branch_id' => $branchId, 'name' => 'Course '.Str::random(5), 'request_id' => (string) Str::uuid()])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", ['name' => 'Stage', 'request_id' => (string) Str::uuid()])->assertCreated()->json('stage');
        $level = $this->postJson("{$this->base}/stages/{$stage['id']}/levels", [
            'name' => 'Level', 'request_id' => (string) Str::uuid(),
            'lectures' => array_map(fn (int $number): array => [
                'number' => $number, 'content' => "Required {$number}", 'planned_hours' => 2,
            ], range(1, $lectureCount)),
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
