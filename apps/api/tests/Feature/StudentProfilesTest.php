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

class StudentProfilesTest extends TestCase
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

    public function test_registration_creates_distinct_students_with_a_shared_contact_and_reuses_one_profile_across_branches(): void
    {
        $this->grant([$this->north => ['registration'], $this->south => ['registration']]);
        $this->asUser($this->staff);
        $payload = ['name' => 'أحمد علي', 'phone' => '01012345678', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $first = $this->postJson("{$this->base}/students", $payload)->assertCreated()->json('student');
        $this->assertIsInt($first['student_number']);
        $second = $this->postJson("{$this->base}/students", [...$payload, 'name' => 'مريم علي', 'request_id' => (string) Str::uuid()])
            ->assertCreated()->json('student');
        $this->assertNotSame($first['student_number'], $second['student_number']);
        $this->getJson("{$this->base}/students/similar?phone=01012345678")->assertOk()->assertJsonCount(2, 'students');
        $this->patchJson("{$this->base}/students/{$first['id']}", [
            'name' => 'أحمد علي حسن', 'phone' => $payload['phone'], 'branch_ids' => [$this->south], 'revision' => $first['revision'],
        ])->assertOk()->assertJsonPath('student.student_number', $first['student_number'])
            ->assertJsonPath('student.branch_ids', [$this->north, $this->south]);
        $this->getJson("{$this->base}/student-workspace")->assertOk()->assertJsonCount(2, 'students');
        $this->asUser($this->owner);
        $this->getJson("{$this->base}/member-workspace")->assertOk()->assertJsonCount(2, 'members');
        $events = collect($this->getJson("{$this->base}/audit")->assertOk()->json('entries'))->where('event', 'student.updated');
        $this->assertCount(2, $events);
        $details = json_decode($events->first()['details'], true);
        $this->assertSame('أحمد علي', $details['before']['name']);
        $this->assertSame('أحمد علي حسن', $details['after']['name']);
        $this->assertSame($this->staff->id, $events->first()['actor_id']);
    }

    public function test_hidden_students_do_not_leak_through_direct_access_similarity_associations_or_audit(): void
    {
        $hidden = $this->createStudent('Hidden', [$this->south]);
        $shared = $this->createStudent('Shared', [$this->north, $this->south]);
        $this->grant([$this->north => ['registration', 'branch_auditor']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/students/{$hidden['id']}")->assertNotFound();
        $this->patchJson("{$this->base}/students/{$hidden['id']}", [
            'name' => 'Overwrite', 'branch_ids' => [$this->north], 'revision' => 1,
        ])->assertNotFound();
        $this->getJson("{$this->base}/students/similar?name=Hidden")->assertOk()->assertJsonCount(0, 'students');
        $this->getJson("{$this->base}/student-workspace")->assertOk()->assertJsonCount(1, 'students')
            ->assertJsonPath('students.0.branch_ids', [$this->north]);
        $this->patchJson("{$this->base}/students/{$shared['id']}", [
            'name' => 'Shared edited', 'branch_ids' => [$this->north], 'revision' => 1,
        ])->assertOk()->assertJsonPath('student.branch_ids', [$this->north]);
        $this->postJson("{$this->base}/students", [
            'name' => 'Denied', 'branch_ids' => [$this->south], 'request_id' => (string) Str::uuid(),
        ])->assertForbidden();
        $audit = $this->getJson("{$this->base}/audit")->assertOk()->json('entries');
        $this->assertStringNotContainsString('Hidden', json_encode($audit));
        $this->assertStringNotContainsString('branch_ids', json_encode($audit));
        $this->asUser($this->owner);
        $this->getJson("{$this->base}/students/{$shared['id']}")->assertOk()->assertJsonPath('students.0.branch_ids', [$this->north, $this->south]);
        $this->grant([$this->north => ['branch_manager', 'attendance']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/students/{$shared['id']}")->assertOk()->assertJsonPath('students.0.can_manage', false);
        $this->patchJson("{$this->base}/students/{$shared['id']}", ['name' => 'No', 'branch_ids' => [$this->north], 'revision' => 2])->assertForbidden();
        $this->grant([]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/students/{$shared['id']}")->assertNotFound();
        $this->getJson("{$this->base}/students/similar?name=Shared%20edited")->assertOk()->assertJsonCount(0, 'students');
    }

    public function test_retries_do_not_duplicate_profiles_and_stale_edits_do_not_overwrite_newer_data(): void
    {
        $payload = ['name' => 'Retry', 'phone' => '٠١٠ ١٢٣٤٥٦٧٨', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->json('student');
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $student['id']);
        $this->postJson("{$this->base}/students", [...$payload, 'name' => 'Different'])->assertConflict();
        $this->getJson("{$this->base}/students/submissions/{$payload['request_id']}")->assertOk()->assertJsonPath('student.id', $student['id']);
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/students/submissions/{$payload['request_id']}")->assertNotFound();
        $this->asUser($this->owner);
        $edit = ['name' => 'New name', 'phone' => $payload['phone'], 'branch_ids' => [$this->north], 'revision' => 1];
        $this->patchJson("{$this->base}/students/{$student['id']}", $edit)->assertOk()->assertJsonPath('student.revision', 2);
        $this->patchJson("{$this->base}/students/{$student['id']}", $edit)->assertOk();
        $this->patchJson("{$this->base}/students/{$student['id']}", [...$edit, 'name' => 'Stale'])->assertConflict()->assertJsonPath('code', 'student_changed');
        $this->getJson("{$this->base}/students/similar?phone=01012345678")->assertOk()->assertJsonCount(1, 'students');
        $events = collect($this->getJson("{$this->base}/audit")->assertOk()->json('entries'))->filter(fn ($entry) => str_starts_with($entry['event'], 'student.'));
        $this->assertCount(2, $events);
        $this->getJson("{$this->base}/student-workspace")->assertOk()->assertJsonCount(1, 'students')->assertJsonPath('students.0.name', 'New name');
    }

    public function test_center_databases_are_independent_and_existing_centers_can_receive_the_migration(): void
    {
        $this->createStudent('Alpha only', [$this->north]);
        $this->center->run(function (): void {
            DB::statement('DROP TABLE student_branches');
            DB::statement('DROP TABLE students');
            DB::table('migrations')->where('migration', '2026_09_26_193307_create_student_profiles')->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $student = $this->createStudent('Migrated', [$this->north]);
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->getJson("{$this->base}/student-workspace")->assertOk()->assertJsonCount(1, 'students')->assertJsonCount(2, 'branches');
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Beta', 'slug' => 'beta', 'subdomain' => 'beta', 'plan' => 'starter', 'owner_email' => 'owner@beta.test',
        ])->assertCreated();
        $beta = Center::where('slug', 'beta')->firstOrFail();
        CenterMembership::create(['tenant_id' => $beta->id, 'user_id' => $this->owner->id, 'status' => 'active']);
        $beta->run(fn () => DB::table('center_grants')->insert(['user_id' => $this->owner->id, 'role' => 'center_owner']));
        $this->actingAs($this->owner, 'web')->withSession(['center_id' => $beta->id]);
        $base = 'http://beta.courses.test/api/v1/center';
        $branch = $this->postJson("{$base}/branches", ['name' => 'Beta branch', 'slug' => 'beta-branch'])->assertCreated()->json('branch.id');
        $this->getJson("{$base}/students/{$student['id']}")->assertNotFound();
        $this->getJson("{$base}/students/similar?name=Migrated")->assertOk()->assertJsonCount(0, 'students');
        $this->postJson("{$base}/students", ['name' => 'Beta student', 'branch_ids' => [$branch], 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->getJson("{$base}/student-workspace")->assertOk()->assertJsonCount(1, 'students');
        $this->asUser($this->owner);
        $this->getJson("{$this->base}/student-workspace")->assertOk()->assertJsonPath('students.0.name', 'Migrated');
    }

    public function test_workspace_is_bounded_and_search_query_count_does_not_grow_with_rows(): void
    {
        $this->createStudent('Student 00', [$this->north]);
        $single = $this->getJson("{$this->base}/student-workspace")->assertOk();
        for ($number = 1; $number <= 51; $number++) {
            $this->createStudent(sprintf('Student %02d', $number), [$this->north, $this->south]);
        }
        $many = $this->getJson("{$this->base}/student-workspace")->assertOk()->assertJsonCount(50, 'students')->assertJsonPath('pagination.has_more', true);
        $this->assertLessThanOrEqual(6, (int) $many->headers->get('X-Courses-Query-Count'));
        $this->assertSame($single->headers->get('X-Courses-Query-Count'), $many->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$this->base}/student-workspace?page=2")->assertOk()->assertJsonCount(2, 'students')->assertJsonPath('pagination.has_more', false);
        $this->getJson("{$this->base}/student-workspace?q=Student%2051")->assertOk()->assertJsonCount(1, 'students');
        $this->getJson("{$this->base}/student-workspace?q=999999999999999999999999999999")->assertOk()->assertJsonCount(0, 'students');
        $this->getJson("{$this->base}/student-workspace?page=-1")->assertUnprocessable();
    }

    public function test_zero_is_a_real_search_value_instead_of_an_empty_search(): void
    {
        $this->postJson("{$this->base}/students", ['name' => 'Matching', 'phone' => '01234', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->postJson("{$this->base}/students", ['name' => 'Other', 'phone' => '56789', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->getJson("{$this->base}/student-workspace?q=0")->assertOk()->assertJsonCount(1, 'students')->assertJsonPath('students.0.name', 'Matching');
    }

    private function createStudent(string $name, array $branches): array
    {
        return $this->postJson("{$this->base}/students", ['name' => $name, 'branch_ids' => $branches, 'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
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
