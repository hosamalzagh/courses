<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class InstructorProfilesTest extends TestCase
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

    public function test_academic_admin_creates_profiles_without_accounts_and_reuses_them_across_authorized_branches(): void
    {
        $this->grant([$this->north => ['academic_admin'], $this->south => ['academic_admin']]);
        $this->asUser($this->staff);
        $payload = ['name' => 'أحمد علي', 'phone' => '01012345678', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $this->postJson("{$this->base}/instructors", [...$payload, 'user_id' => $this->staff->id])->assertUnprocessable()->assertJsonValidationErrors('user_id');
        $first = $this->postJson("{$this->base}/instructors", $payload)->assertCreated()->json('instructor');
        $second = $this->postJson("{$this->base}/instructors", [...$payload, 'name' => 'مريم علي', 'request_id' => (string) Str::uuid()])
            ->assertCreated()->json('instructor');
        $this->assertNotSame($first['id'], $second['id']);
        $this->patchJson("{$this->base}/instructors/{$first['id']}", [
            'name' => 'أحمد علي حسن', 'phone' => $payload['phone'], 'branch_ids' => [$this->south], 'revision' => $first['revision'],
        ])->assertOk()->assertJsonPath('instructor.id', $first['id'])
            ->assertJsonPath('instructor.branch_ids', [$this->north, $this->south]);
        $this->getJson("{$this->base}/instructor-workspace")->assertOk()->assertJsonCount(2, 'instructors');
        $this->asUser($this->owner);
        $this->getJson("{$this->base}/member-workspace")->assertOk()->assertJsonCount(2, 'members');
        $events = collect($this->getJson("{$this->base}/audit")->assertOk()->json('entries'))->where('event', 'instructor.updated');
        $this->assertCount(2, $events);
        $details = json_decode($events->first()['details'], true);
        $this->assertSame('أحمد علي', $details['before']['name']);
        $this->assertSame('أحمد علي حسن', $details['after']['name']);
        $this->assertSame($this->staff->id, $events->first()['actor_id']);
    }

    public function test_hidden_instructors_do_not_leak_through_direct_access_associations_or_audit(): void
    {
        $hidden = $this->createInstructor('Hidden', [$this->south]);
        $shared = $this->createInstructor('Shared', [$this->north, $this->south]);
        $this->grant([$this->north => ['academic_admin', 'branch_auditor']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/instructors/{$hidden['id']}")->assertNotFound();
        $this->patchJson("{$this->base}/instructors/{$hidden['id']}", [
            'name' => 'Overwrite', 'branch_ids' => [$this->north], 'revision' => 1,
        ])->assertNotFound();
        $this->getJson("{$this->base}/instructor-workspace")->assertOk()->assertJsonCount(1, 'instructors')
            ->assertJsonPath('instructors.0.branch_ids', [$this->north]);
        $this->patchJson("{$this->base}/instructors/{$shared['id']}", [
            'name' => 'Shared edited', 'branch_ids' => [$this->north], 'revision' => 1,
        ])->assertOk()->assertJsonPath('instructor.branch_ids', [$this->north]);
        $this->postJson("{$this->base}/instructors", [
            'name' => 'Denied', 'branch_ids' => [$this->south], 'request_id' => (string) Str::uuid(),
        ])->assertForbidden();
        $audit = $this->getJson("{$this->base}/audit")->assertOk()->json('entries');
        $this->assertStringNotContainsString('Hidden', json_encode($audit));
        $this->assertStringNotContainsString('branch_ids', json_encode($audit));
        $this->asUser($this->owner);
        $this->getJson("{$this->base}/instructors/{$shared['id']}")->assertOk()->assertJsonPath('instructors.0.branch_ids', [$this->north, $this->south]);
        $this->grant([$this->north => ['branch_manager', 'registration', 'attendance', 'center_student_search']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/instructors/{$hidden['id']}")->assertNotFound();
        $this->getJson("{$this->base}/instructors/{$shared['id']}")->assertOk()->assertJsonPath('instructors.0.can_manage', false);
        $this->patchJson("{$this->base}/instructors/{$shared['id']}", ['name' => 'No', 'branch_ids' => [$this->north], 'revision' => 2])->assertForbidden();
        $this->grant([]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/instructors/{$shared['id']}")->assertNotFound();
    }

    public function test_retries_do_not_duplicate_profiles_and_stale_edits_do_not_overwrite_newer_data(): void
    {
        $payload = ['name' => 'Retry', 'phone' => '٠١٠ ١٢٣٤٥٦٧٨', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $instructor = $this->postJson("{$this->base}/instructors", $payload)->assertCreated()->json('instructor');
        $this->postJson("{$this->base}/instructors", $payload)->assertOk()->assertJsonPath('instructor.id', $instructor['id']);
        $this->postJson("{$this->base}/instructors", [...$payload, 'name' => 'Different'])->assertConflict();
        $this->getJson("{$this->base}/instructors/submissions/{$payload['request_id']}")->assertOk()->assertJsonPath('instructor.id', $instructor['id']);
        $this->grant([$this->north => ['academic_admin']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/instructors/submissions/{$payload['request_id']}")->assertNotFound();
        $this->asUser($this->owner);
        $edit = ['name' => 'New name', 'phone' => $payload['phone'], 'branch_ids' => [$this->north], 'revision' => 1];
        $this->patchJson("{$this->base}/instructors/{$instructor['id']}", $edit)->assertOk()->assertJsonPath('instructor.revision', 2);
        $this->patchJson("{$this->base}/instructors/{$instructor['id']}", $edit)->assertOk();
        $this->patchJson("{$this->base}/instructors/{$instructor['id']}", [...$edit, 'name' => 'Stale'])->assertConflict()->assertJsonPath('code', 'instructor_changed');
        $events = collect($this->getJson("{$this->base}/audit")->assertOk()->json('entries'))->filter(fn ($entry) => str_starts_with($entry['event'], 'instructor.'));
        $this->assertCount(2, $events);
        $this->getJson("{$this->base}/instructor-workspace")->assertOk()->assertJsonCount(1, 'instructors')->assertJsonPath('instructors.0.name', 'New name');
    }

    public function test_center_databases_are_independent_and_existing_centers_can_receive_the_migration(): void
    {
        $this->createInstructor('Alpha only', [$this->north]);
        $this->center->run(function (): void {
            $waitlistMigration = glob(database_path('migrations/tenant/*_create_study_attempt_waitlists.php'))[0];
            (require $waitlistMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($waitlistMigration, PATHINFO_FILENAME))->delete();
            $attendanceMigration = glob(database_path('migrations/tenant/*_create_study_attendance.php'))[0];
            (require $attendanceMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($attendanceMigration, PATHINFO_FILENAME))->delete();
            $allocationsMigration = glob(database_path('migrations/tenant/*_create_student_payment_allocations.php'))[0];
            (require $allocationsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($allocationsMigration, PATHINFO_FILENAME))->delete();
            $sessionsMigration = glob(database_path('migrations/tenant/*_create_study_sessions.php'))[0];
            (require $sessionsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($sessionsMigration, PATHINFO_FILENAME))->delete();
            $withdrawalsMigration = glob(database_path('migrations/tenant/*_add_study_attempt_withdrawals_and_repeats.php'))[0];
            (require $withdrawalsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($withdrawalsMigration, PATHINFO_FILENAME))->delete();
            $attemptsMigration = glob(database_path('migrations/tenant/*_create_study_attempts.php'))[0];
            (require $attemptsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($attemptsMigration, PATHINFO_FILENAME))->delete();
            $groupsMigration = glob(database_path('migrations/tenant/*_create_study_groups.php'))[0];
            (require $groupsMigration)->down();
            DB::statement('DROP TABLE instructor_branches');
            DB::statement('DROP TABLE instructors');
            DB::table('migrations')->where('migration', '2026_09_28_010000_create_study_groups')->delete();
            DB::table('migrations')->where('migration', '2026_09_26_201733_create_instructor_profiles')->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']), Artisan::output());
        $instructor = $this->createInstructor('Migrated', [$this->north]);
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->getJson("{$this->base}/instructor-workspace")->assertOk()->assertJsonCount(1, 'instructors')->assertJsonCount(2, 'branches');
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Beta', 'slug' => 'beta', 'subdomain' => 'beta', 'plan' => 'starter', 'owner_email' => 'owner@beta.test',
        ])->assertCreated();
        $beta = Center::where('slug', 'beta')->firstOrFail();
        CenterMembership::create(['tenant_id' => $beta->id, 'user_id' => $this->owner->id, 'status' => 'active']);
        $beta->run(fn () => DB::table('center_grants')->insert(['user_id' => $this->owner->id, 'role' => 'center_owner']));
        $this->actingAs($this->owner, 'web')->withSession(['center_id' => $beta->id]);
        $base = 'http://beta.courses.test/api/v1/center';
        $branch = $this->postJson("{$base}/branches", ['name' => 'Beta branch', 'slug' => 'beta-branch'])->assertCreated()->json('branch.id');
        $this->getJson("{$base}/instructors/{$instructor['id']}")->assertNotFound();
        $this->postJson("{$base}/instructors", ['name' => 'Beta instructor', 'branch_ids' => [$branch], 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->getJson("{$base}/instructor-workspace")->assertOk()->assertJsonCount(1, 'instructors');
        $this->asUser($this->owner);
        $this->getJson("{$this->base}/instructor-workspace")->assertOk()->assertJsonPath('instructors.0.name', 'Migrated');
    }

    public function test_workspace_is_bounded_and_search_query_count_does_not_grow_with_rows(): void
    {
        $this->createInstructor('Instructor 00', [$this->north]);
        $single = $this->getJson("{$this->base}/instructor-workspace")->assertOk();
        for ($number = 1; $number <= 51; $number++) {
            $this->createInstructor(sprintf('Instructor %02d', $number), [$this->north, $this->south]);
        }
        $many = $this->getJson("{$this->base}/instructor-workspace")->assertOk()->assertJsonCount(50, 'instructors')->assertJsonPath('pagination.has_more', true);
        $this->assertLessThanOrEqual(6, (int) $many->headers->get('X-Courses-Query-Count'));
        $this->assertSame($single->headers->get('X-Courses-Query-Count'), $many->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$this->base}/instructor-workspace?page=2")->assertOk()->assertJsonCount(2, 'instructors')->assertJsonPath('pagination.has_more', false);
        $this->getJson("{$this->base}/instructor-workspace?q=Instructor%2051")->assertOk()->assertJsonCount(1, 'instructors');
        $this->getJson("{$this->base}/instructor-workspace?q=999999999999999999999999999999")->assertOk()->assertJsonCount(0, 'instructors');
        $this->getJson("{$this->base}/instructor-workspace?page=-1")->assertUnprocessable();
    }

    public function test_zero_is_a_real_search_value_instead_of_an_empty_search(): void
    {
        $this->postJson("{$this->base}/instructors", ['name' => 'Matching', 'phone' => '01234', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->postJson("{$this->base}/instructors", ['name' => 'Other', 'phone' => '56789', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->getJson("{$this->base}/instructor-workspace?q=0")->assertOk()->assertJsonCount(1, 'instructors')->assertJsonPath('instructors.0.name', 'Matching');
    }

    private function createInstructor(string $name, array $branches): array
    {
        return $this->postJson("{$this->base}/instructors", ['name' => $name, 'branch_ids' => $branches, 'request_id' => (string) Str::uuid()])->assertCreated()->json('instructor');
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
