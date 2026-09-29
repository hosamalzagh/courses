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

class CenterStudentSearchTest extends TestCase
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

    public function test_center_search_requires_policy_and_independent_permission_and_returns_only_basic_data(): void
    {
        $hidden = $this->createStudent('Hidden sibling', [$this->south]);
        $shared = $this->createStudent('Shared sibling', [$this->north, $this->south]);
        $this->getJson("{$this->base}/student-search-workspace")->assertOk()->assertJsonPath('policy.enabled', false);
        $this->getJson("{$this->base}/student-workspace")->assertOk()->assertJsonPath('student_search_enabled', false);
        $this->grant([$this->north => ['registration', 'center_student_search']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/student-search-workspace?q=sibling")->assertOk()->assertJsonCount(0, 'students');
        $this->patchJson("{$this->base}/student-search-policy", ['enabled' => true, 'revision' => 1])->assertForbidden();
        $this->asUser($this->owner);
        $this->patchJson("{$this->base}/student-search-policy", ['enabled' => true, 'revision' => 1])->assertOk()->assertJsonPath('policy.revision', 2);
        $this->getJson("{$this->base}/student-workspace")->assertOk()->assertJsonPath('student_search_enabled', true);
        $this->asUser($this->staff);
        $result = $this->getJson("{$this->base}/student-search-workspace?q=sibling")->assertOk()->assertJsonCount(2, 'students');
        $this->assertEqualsCanonicalizing(['id', 'student_number', 'name', 'phone', 'within_scope'], array_keys($result->json('students.0')));
        $this->assertFalse(collect($result->json('students'))->firstWhere('id', $hidden['id'])['within_scope']);
        $this->assertTrue(collect($result->json('students'))->firstWhere('id', $shared['id'])['within_scope']);
        $this->getJson("{$this->base}/students/{$hidden['id']}")->assertNotFound();
        $this->patchJson("{$this->base}/students/{$hidden['id']}", ['name' => 'Overwrite', 'branch_ids' => [$this->north], 'revision' => 1])->assertNotFound();
        $this->getJson("{$this->base}/students/similar?name=Hidden%20sibling")->assertOk()->assertJsonCount(1, 'students')->assertJsonPath('students.0.within_scope', false)->assertJsonMissingPath('students.0.branch_ids')->assertJsonMissingPath('students.0.revision')->assertJsonMissingPath('students.0.can_manage');
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/student-search-workspace?q=sibling")->assertForbidden();
        $this->getJson("{$this->base}/students/similar?name=Hidden%20sibling")->assertOk()->assertJsonCount(0, 'students');
        $this->asUser($this->owner);
        $this->patchJson("{$this->base}/student-search-policy", ['enabled' => false, 'revision' => 2])->assertOk();
        $this->getJson("{$this->base}/student-workspace")->assertOk()->assertJsonPath('student_search_enabled', false)->assertJsonCount(2, 'students');
    }

    public function test_settings_hint_skips_manager_search_but_preserves_search_for_non_managers(): void
    {
        $student = $this->createStudent('Settings retained', [$this->north]);
        $this->patchJson("{$this->base}/student-search-policy", ['enabled' => true, 'revision' => 1])->assertOk();
        $this->getJson("{$this->base}/student-search-workspace?q=Settings%20retained&page=2&view=settings")
            ->assertOk()->assertJsonCount(0, 'students')->assertJsonPath('pagination.page', 1);

        $this->grant([$this->north => ['registration', 'center_student_search']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/student-search-workspace?q=Settings%20retained&page=1&view=settings")
            ->assertOk()->assertJsonPath('students.0.id', $student['id'])->assertJsonPath('pagination.page', 1);
    }

    public function test_policy_retries_are_safe_stale_changes_conflict_and_audit_is_manager_only(): void
    {
        $this->patchJson("{$this->base}/student-search-policy", ['enabled' => true, 'revision' => 1])->assertOk()->assertJsonPath('policy.revision', 2);
        $this->patchJson("{$this->base}/student-search-policy", ['enabled' => true, 'revision' => 1])->assertOk()->assertJsonPath('policy.revision', 2);
        $this->patchJson("{$this->base}/student-search-policy", ['enabled' => false, 'revision' => 1])->assertConflict()->assertJsonPath('code', 'student_search_policy_changed');
        $events = collect($this->getJson("{$this->base}/audit")->assertOk()->json('entries'))->where('event', 'center.student_search_changed');
        $this->assertCount(1, $events);
        $details = json_decode($events->first()['details'], true);
        $this->assertSame(['before' => ['enabled' => false], 'after' => ['enabled' => true]], $details);
        $this->assertSame($this->owner->id, $events->first()['actor_id']);
        $this->grant([$this->north => ['branch_auditor', 'center_student_search']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/audit")->assertOk()->assertJsonMissing(['event' => 'center.student_search_changed']);
        $this->patchJson("{$this->base}/student-search-policy", ['enabled' => false, 'revision' => 2])->assertForbidden();
        $this->asUser($this->owner);
        $this->patchJson("{$this->base}/student-search-policy", ['enabled' => false, 'revision' => 2])->assertOk()->assertJsonPath('policy.revision', 3);
    }

    public function test_center_search_is_bounded_flat_with_rows_and_respects_zero_and_normalized_contacts(): void
    {
        $this->patchJson("{$this->base}/student-search-policy", ['enabled' => true, 'revision' => 1])->assertOk();
        $this->createStudent('Search 00', [$this->south]);
        $one = $this->getJson("{$this->base}/student-search-workspace?q=Search")->assertOk();
        for ($number = 1; $number <= 51; $number++) {
            $this->createStudent(sprintf('Search %02d', $number), [$this->north, $this->south]);
        }
        $many = $this->getJson("{$this->base}/student-search-workspace?q=Search")->assertOk()->assertJsonCount(50, 'students')->assertJsonPath('pagination.has_more', true);
        $this->assertLessThanOrEqual(6, (int) $many->headers->get('X-Courses-Query-Count'));
        $this->assertSame($one->headers->get('X-Courses-Query-Count'), $many->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$this->base}/student-search-workspace?q=Search&page=2")->assertOk()->assertJsonCount(2, 'students');
        $this->getJson("{$this->base}/student-search-workspace?q=Search%2051")->assertOk()->assertJsonCount(1, 'students');
        $this->getJson("{$this->base}/student-search-workspace?q=99999999999999999999999")->assertOk()->assertJsonCount(0, 'students');
        $this->getJson("{$this->base}/student-search-workspace?page=0")->assertUnprocessable();
        $this->postJson("{$this->base}/students", ['name' => 'Contact match', 'phone' => '٠١٢ ٣٤', 'branch_ids' => [$this->south], 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->getJson("{$this->base}/student-search-workspace?q=01234")->assertOk()->assertJsonCount(1, 'students');
        $this->getJson("{$this->base}/student-search-workspace?q=0")->assertOk()->assertJsonPath('pagination.has_more', false);
        $this->getJson("{$this->base}/student-search-workspace")->assertOk()->assertJsonCount(0, 'students');
    }

    public function test_existing_and_new_centers_receive_an_independent_disabled_policy_without_rewriting_students(): void
    {
        $student = $this->createStudent('Preserved', [$this->south]);
        $this->center->run(function (): void {
            $migration = glob(database_path('migrations/tenant/*_add_student_cross_branch_sharing.php'))[0];
            (require $migration)->down();
            DB::table('migrations')->where('migration', pathinfo($migration, PATHINFO_FILENAME))->delete();
            DB::statement('DROP TABLE student_search_policy');
            DB::table('migrations')->where('migration', '2026_09_26_201812_create_student_search_policy')->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->getJson("{$this->base}/student-search-workspace")->assertOk()->assertJsonPath('policy.enabled', false);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.name', 'Preserved');
        $this->patchJson("{$this->base}/student-search-policy", ['enabled' => true, 'revision' => 1])->assertOk();
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->getJson("{$this->base}/student-search-workspace")->assertOk()->assertJsonPath('policy.enabled', true);
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Beta', 'slug' => 'beta', 'subdomain' => 'beta', 'plan' => 'starter', 'owner_email' => 'owner@beta.test',
        ])->assertCreated();
        $beta = Center::where('slug', 'beta')->firstOrFail();
        CenterMembership::create(['tenant_id' => $beta->id, 'user_id' => $this->owner->id, 'status' => 'active']);
        $beta->run(fn () => DB::table('center_grants')->insert(['user_id' => $this->owner->id, 'role' => 'center_owner']));
        $this->actingAs($this->owner, 'web')->withSession(['center_id' => $beta->id]);
        $base = 'http://beta.courses.test/api/v1/center';
        $this->getJson("{$base}/student-search-workspace")->assertOk()->assertJsonPath('policy.enabled', false);
        $this->patchJson("{$base}/student-search-policy", ['enabled' => true, 'revision' => 1])->assertOk();
        $this->getJson("{$base}/student-search-workspace?q=Preserved")->assertOk()->assertJsonCount(0, 'students');
        $this->getJson("{$base}/students/{$student['id']}")->assertNotFound();
    }

    public function test_new_profile_sharing_uses_the_saved_default_without_rewriting_existing_profiles(): void
    {
        $first = $this->createStudent('First', [$this->north]);
        $this->assertTrue($first['sharing_enabled']);
        $this->patchJson("{$this->base}/student-search-policy", ['default_sharing_enabled' => false, 'revision' => 1])
            ->assertOk()->assertJsonPath('policy.enabled', false)->assertJsonPath('policy.default_sharing_enabled', false);
        $second = $this->createStudent('Second', [$this->south]);
        $this->assertFalse($second['sharing_enabled']);
        $this->getJson("{$this->base}/students/{$first['id']}")->assertOk()->assertJsonPath('students.0.sharing_enabled', true);
    }

    public function test_eight_discovery_conditions_and_similar_warnings_preserve_branch_access(): void
    {
        $outside = $this->createStudent('Matrix outside', [$this->south]);
        $inside = $this->createStudent('Matrix inside', [$this->north]);
        foreach ([false, true] as $enabled) {
            foreach ([false, true] as $sharing) {
                foreach ([false, true] as $grant) {
                    $this->asUser($this->owner);
                    $policy = $this->getJson("{$this->base}/student-search-workspace")->json('policy');
                    $this->patchJson("{$this->base}/student-search-policy", ['enabled' => $enabled, 'revision' => $policy['revision']])->assertOk();
                    foreach ([$outside, $inside] as $student) {
                        $current = $this->getJson("{$this->base}/students/{$student['id']}")->json('students.0');
                        $this->patchJson("{$this->base}/students/{$student['id']}/sharing", ['sharing_enabled' => $sharing, 'revision' => $current['revision']])->assertOk();
                    }
                    $this->grant([$this->north => $grant ? ['registration', 'center_student_search'] : ['registration']]);
                    $this->asUser($this->staff);
                    $this->getJson("{$this->base}/students/similar?name=Matrix%20outside")->assertOk()->assertJsonCount($enabled && $sharing && $grant ? 1 : 0, 'students');
                    $this->getJson("{$this->base}/students/similar?name=Matrix%20inside")->assertOk()->assertJsonCount(1, 'students');
                    $search = $this->getJson("{$this->base}/student-search-workspace?q=Matrix");
                    if ($grant) {
                        $search->assertOk()->assertJsonCount($enabled ? ($sharing ? 2 : 1) : 0, 'students');
                    } else {
                        $search->assertForbidden();
                    }
                    $this->getJson("{$this->base}/students/{$outside['id']}")->assertNotFound();
                    $this->patchJson("{$this->base}/students/{$outside['id']}/sharing", ['sharing_enabled' => true, 'revision' => 1])->assertNotFound();
                    $this->getJson("{$this->base}/students/{$inside['id']}")->assertOk();
                }
            }
        }
    }

    public function test_sharing_is_a_separate_audited_action_with_safe_retries_conflicts_and_revocation(): void
    {
        $student = $this->createStudent('Sharing action', [$this->north, $this->south]);
        $this->grant([$this->north => ['registration', 'branch_auditor']]);
        $this->asUser($this->staff);
        $url = "{$this->base}/students/{$student['id']}/sharing";
        $this->patchJson($url, ['sharing_enabled' => false, 'revision' => 1])->assertOk()->assertJsonPath('student.revision', 2)->assertJsonPath('student.sharing_enabled', false);
        $this->patchJson($url, ['sharing_enabled' => false, 'revision' => 1])->assertOk()->assertJsonPath('student.revision', 2);
        $this->patchJson($url, ['sharing_enabled' => true, 'revision' => 1])->assertConflict();
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'Changed name', 'branch_ids' => [$this->north], 'revision' => 2])->assertOk()->assertJsonPath('student.sharing_enabled', false);
        $events = collect($this->getJson("{$this->base}/audit")->assertOk()->json('entries'))->where('event', 'student.sharing_changed');
        $this->assertCount(1, $events);
        $event = $events->first();
        $this->assertSame($this->staff->id, $event['actor_id']);
        $this->assertNotEmpty($event['created_at']);
        $this->assertSame(['student_id' => $student['id'], 'before' => ['sharing_enabled' => true], 'after' => ['sharing_enabled' => false]], json_decode($event['details'], true));
        $this->grant([$this->north => ['attendance']]);
        $this->asUser($this->staff);
        $this->patchJson($url, ['sharing_enabled' => true, 'revision' => 3])->assertForbidden();
        $this->asUser($this->owner);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.sharing_enabled', false);
    }

    public function test_existing_profiles_keep_their_discovery_eligibility_and_history_when_migrated(): void
    {
        $student = $this->createStudent('Legacy profile', [$this->south]);
        $this->patchJson("{$this->base}/student-search-policy", ['enabled' => true, 'revision' => 1])->assertOk();
        $events = $this->getJson("{$this->base}/audit")->assertOk()->json('entries');
        $this->center->run(function (): void {
            $migration = glob(database_path('migrations/tenant/*_add_student_cross_branch_sharing.php'))[0];
            (require $migration)->down();
            DB::table('migrations')->where('migration', pathinfo($migration, PATHINFO_FILENAME))->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()
            ->assertJsonPath('students.0.student_number', $student['student_number'])
            ->assertJsonPath('students.0.revision', 1)->assertJsonPath('students.0.sharing_enabled', true);
        $this->getJson("{$this->base}/student-search-workspace?q=Legacy")->assertOk()
            ->assertJsonPath('policy.enabled', true)->assertJsonCount(1, 'students');
        $this->assertSame($events, $this->getJson("{$this->base}/audit")->json('entries'));
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->getJson("{$this->base}/student-workspace")->assertOk()->assertJsonCount(1, 'students');
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
