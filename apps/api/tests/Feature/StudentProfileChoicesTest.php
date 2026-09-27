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

class StudentProfileChoicesTest extends TestCase
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

    public function test_manager_creates_a_choice_and_registration_uses_it_without_managing_definitions(): void
    {
        $payload = ['id' => (string) Str::uuid(), 'kind' => 'city', 'label' => 'القاهرة', 'position' => 10, 'active' => true];
        $choice = $this->postJson("{$this->base}/student-profile-choices", $payload)->assertCreated()->json('choice');
        $this->postJson("{$this->base}/student-profile-choices", $payload)->assertOk()->assertJsonPath('choice.id', $choice['id']);
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $this->postJson("{$this->base}/student-profile-choices", [...$payload, 'id' => (string) Str::uuid()])->assertForbidden();
        $student = $this->postJson("{$this->base}/students", ['name' => 'طالب القوائم', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'city_id' => $choice['id']])->assertCreated()->assertJsonPath('student.city_id', $choice['id'])->json('student');
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.profile_choices.city.label', 'القاهرة');
    }

    public function test_disabled_choices_keep_old_meaning_and_reject_new_use_and_wrong_categories(): void
    {
        $choice = $this->postJson("{$this->base}/student-profile-choices", ['id' => (string) Str::uuid(), 'kind' => 'city', 'label' => 'القاهرة', 'position' => 1, 'active' => true])->assertCreated()->json('choice');
        $creation = ['name' => 'طالب قديم', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'city_id' => $choice['id']];
        $student = $this->postJson("{$this->base}/students", $creation)->assertCreated()->json('student');
        $route = "{$this->base}/student-profile-choices/{$choice['id']}";
        $change = ['label' => 'القاهرة الجديدة', 'position' => 2, 'active' => false, 'revision' => 1];
        $this->patchJson($route, $change)->assertOk()->assertJsonPath('choice.revision', 2);
        $this->patchJson($route, $change)->assertOk()->assertJsonPath('choice.revision', 2);
        $this->patchJson($route, [...$change, 'label' => 'تعديل قديم'])->assertConflict();
        $this->postJson("{$this->base}/students", $creation)->assertOk()->assertJsonPath('student.id', $student['id']);
        $this->postJson("{$this->base}/students", [...$creation, 'request_id' => (string) Str::uuid()])->assertUnprocessable()->assertJsonValidationErrors('city_id');
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'طالب معدل', 'branch_ids' => [], 'revision' => 1, 'city_id' => $choice['id'], 'school' => 'نص حر'])->assertOk()->assertJsonPath('student.city_id', $choice['id'])->assertJsonPath('student.profile_choices.city.label', 'القاهرة الجديدة');
        $this->postJson("{$this->base}/students", ['name' => 'نوع خاطئ', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'profession_id' => $choice['id']])->assertUnprocessable()->assertJsonValidationErrors('profession_id');
        $this->getJson("{$this->base}/student-profile-choices?kind=city")->assertOk()->assertJsonCount(0, 'choices');
        $this->getJson("{$this->base}/student-profile-choices?kind=city&manage=1")->assertOk()->assertJsonCount(1, 'choices');
        $entries = $this->getJson("{$this->base}/audit")->assertOk()->json('entries');
        $this->assertCount(2, array_filter($entries, fn ($entry) => $entry['event'] === 'center.student_profile_choice_changed'));
    }

    public function test_center_admin_can_manage_and_revoked_role_cannot_write_the_next_request(): void
    {
        $this->center->run(fn () => DB::table('center_grants')->insert(['user_id' => $this->staff->id, 'role' => 'center_admin', 'created_at' => now(), 'updated_at' => now()]));
        $this->asUser($this->staff);
        $payload = ['id' => (string) Str::uuid(), 'kind' => 'profession', 'label' => 'طالب', 'position' => 0, 'active' => true];
        $this->postJson("{$this->base}/student-profile-choices", $payload)->assertCreated();
        $this->center->run(fn () => DB::table('center_grants')->where('user_id', $this->staff->id)->delete());
        $this->patchJson("{$this->base}/student-profile-choices/{$payload['id']}", [...$payload, 'kind' => null, 'revision' => 1, 'label' => 'تجاوز'])->assertForbidden();
        $this->getJson("{$this->base}/student-profile-choices?kind=profession&manage=1")->assertForbidden();
    }

    public function test_choices_are_bounded_sorted_and_a_foreign_center_choice_cannot_be_selected(): void
    {
        $foreign = (string) Str::uuid();
        $this->postJson("{$this->base}/students", ['name' => 'طالب', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'city_id' => $foreign])->assertUnprocessable()->assertJsonValidationErrors('city_id');
        for ($i = 0; $i < 52; $i++) {
            $this->postJson("{$this->base}/student-profile-choices", ['id' => (string) Str::uuid(), 'kind' => 'city', 'label' => 'مدينة '.$i, 'position' => $i, 'active' => true])->assertCreated();
        }
        $this->getJson("{$this->base}/student-profile-choices?kind=city&manage=1")->assertOk()->assertJsonCount(50, 'choices')->assertJsonPath('pagination.has_more', true)->assertJsonPath('choices.0.label', 'مدينة 0');
        $this->getJson("{$this->base}/student-profile-choices?kind=city&page=2")->assertOk()->assertJsonCount(2, 'choices')->assertJsonPath('choices.0.label', 'مدينة 50');
        $workspace = $this->getJson("{$this->base}/student-workspace")->assertOk()->assertJsonCount(50, 'profile_choice_lists.city.choices')->assertJsonPath('profile_choice_lists.city.has_more', true);
        $this->assertLessThanOrEqual(6, (int) $workspace->headers->get('X-Courses-Query-Count'));
    }

    public function test_lists_are_independent_for_two_centers_with_the_same_login_identity(): void
    {
        $choice = $this->postJson("{$this->base}/student-profile-choices", ['id' => (string) Str::uuid(), 'kind' => 'city', 'label' => 'مدينة ألفا', 'position' => 0, 'active' => true])->assertCreated()->json('choice');
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')->postJson('http://courses.test/api/v1/platform/centers', ['name' => 'Beta', 'slug' => 'beta', 'subdomain' => 'beta', 'plan' => 'starter', 'owner_email' => 'owner@beta.test'])->assertCreated();
        $beta = Center::where('slug', 'beta')->firstOrFail();
        CenterMembership::create(['tenant_id' => $beta->id, 'user_id' => $this->owner->id, 'status' => 'active']);
        $beta->run(fn () => DB::table('center_grants')->insert(['user_id' => $this->owner->id, 'role' => 'center_owner']));
        $this->actingAs($this->owner, 'web')->withSession(['center_id' => $beta->id]);
        $base = 'http://beta.courses.test/api/v1/center';
        $branch = $this->postJson("{$base}/branches", ['name' => 'Beta', 'slug' => 'beta'])->assertCreated()->json('branch.id');
        $this->getJson("{$base}/student-profile-choices?kind=city&manage=1")->assertOk()->assertJsonCount(0, 'choices')->assertDontSee('مدينة ألفا');
        $this->getJson("{$base}/student-profile-choices/{$choice['id']}")->assertNotFound();
        $this->patchJson("{$base}/student-profile-choices/{$choice['id']}", ['label' => 'تجاوز', 'active' => true, 'position' => 1, 'revision' => 1])->assertNotFound();
        $this->postJson("{$base}/students", ['name' => 'طالب بيتا', 'branch_ids' => [$branch], 'request_id' => (string) Str::uuid(), 'city_id' => $choice['id']])->assertUnprocessable()->assertJsonValidationErrors('city_id');
    }

    public function test_existing_center_migration_keeps_student_identity_requests_history_and_numbering(): void
    {
        $creation = ['name' => 'قبل الترحيل', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'phone' => '01012345678'];
        $student = $this->postJson("{$this->base}/students", $creation)->assertCreated()->json('student');
        $this->center->run(function (): void {
            $migration = glob(database_path('migrations/tenant/*_create_student_profile_choices.php'))[0];
            (require $migration)->down();
            DB::table('migrations')->where('migration', pathinfo($migration, PATHINFO_FILENAME))->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->postJson("{$this->base}/students", $creation)->assertOk()->assertJsonPath('student.id', $student['id'])->assertJsonPath('student.student_number', $student['student_number'])->assertJsonPath('student.branch_ids', [$this->north])->assertJsonPath('student.city_id', null);
        $entries = $this->getJson("{$this->base}/audit")->assertOk()->json('entries');
        $this->assertCount(1, array_filter($entries, fn ($entry) => $entry['event'] === 'student.created'));
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
