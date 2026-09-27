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

class StudentIdentityTest extends TestCase
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

    public function test_owner_reviews_birth_before_saving_identity_and_passports_remain_optional(): void
    {
        $this->postJson("{$this->base}/students/identity-preview", ['national_id' => '28001010100001', 'branch_ids' => [$this->north]])->assertOk()->assertJsonPath('date_of_birth', '1980-01-01')->assertJsonPath('conflict', false);
        $this->postJson("{$this->base}/students/identity-preview", ['national_id' => '30002290100001', 'branch_ids' => [$this->north], 'date_of_birth' => '2000-03-01'])->assertOk()->assertJsonPath('date_of_birth', '2000-02-29')->assertJsonPath('conflict', true);
        $payload = ['name' => 'هوية اصطناعية', 'national_id' => '30002290100001', 'passport_number' => '000A-SYNTHETIC', 'date_of_birth' => '2000-02-29', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->assertJsonPath('student.identity.national_id', '30002290100001')->assertJsonPath('student.identity.passport_number', '000A-SYNTHETIC')->json('student');
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $student['id']);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.identity.national_id', '30002290100001');
        $this->postJson("{$this->base}/students", ['name' => 'جواز بلا ميلاد', 'passport_number' => '000A-SYNTHETIC', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated()->assertJsonPath('student.age', null)->assertJsonPath('student.identity.passport_number', '000A-SYNTHETIC');
        foreach (['student-workspace', 'students/similar?name='.urlencode($payload['name']), "students/{$student['id']}/barcode", 'audit'] as $path) {
            $this->getJson("{$this->base}/{$path}")->assertOk()->assertDontSee($payload['national_id'])->assertDontSee($payload['passport_number']);
        }
    }

    public function test_only_owner_grants_identity_and_revocation_does_not_expand_branch_access_or_erase_hidden_values(): void
    {
        $payload = ['name' => 'هوية محجوبة', 'national_id' => '30002290100001', 'passport_number' => '000HIDDEN-SYNTHETIC', 'date_of_birth' => '2000-02-29', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->json('student');
        $south = $this->postJson("{$this->base}/students", [...$payload, 'national_id' => '30101010100001', 'date_of_birth' => '2001-01-01', 'branch_ids' => [$this->south], 'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", ['center_roles' => ['center_admin'], 'branch_roles' => []])->assertOk();
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.identity.national_id', $payload['national_id']);
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", ['center_roles' => ['center_admin'], 'branch_roles' => [$this->north => ['registration', 'student_identity']]])->assertForbidden();
        $this->grant([$this->north => ['registration', 'branch_auditor', 'student_identity']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.identity.passport_number', $payload['passport_number']);
        $this->getJson("{$this->base}/students/{$south['id']}")->assertNotFound();
        $duplicate = [...$payload, 'national_id' => $south['identity']['national_id'], 'date_of_birth' => '2001-01-01', 'request_id' => (string) Str::uuid()];
        $this->postJson("{$this->base}/students", $duplicate)->assertUnprocessable()->assertJsonValidationErrors('national_id')->assertDontSee($south['name'])->assertDontSee($duplicate['national_id']);
        $this->grant([$this->north => ['registration', 'branch_auditor']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonMissingPath('students.0.identity')->assertJsonPath('students.0.can_manage_identity', false);
        $edit = ['name' => 'تعديل عام', 'branch_ids' => [], 'revision' => 1];
        $this->patchJson("{$this->base}/students/{$student['id']}", [...$edit, 'national_id' => null])->assertForbidden();
        $this->postJson("{$this->base}/students/identity-preview", ['national_id' => $payload['national_id'], 'student_id' => $student['id'], 'branch_ids' => []])->assertForbidden();
        $this->patchJson("{$this->base}/students/{$student['id']}", $edit)->assertOk()->assertJsonMissingPath('student.identity');
        foreach (["students/{$student['id']}", 'student-workspace', 'students/similar?name='.urlencode($edit['name']), "students/{$student['id']}/barcode", 'audit'] as $path) {
            $this->getJson("{$this->base}/{$path}")->assertOk()->assertDontSee($payload['national_id'])->assertDontSee($payload['passport_number']);
        }
        $this->asUser($this->owner);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.identity.national_id', $payload['national_id'])->assertJsonPath('students.0.identity.passport_number', $payload['passport_number']);
        $this->grant([$this->south => ['registration', 'student_identity']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertNotFound();
        $this->patchJson("{$this->base}/students/{$student['id']}", [...$edit, 'revision' => 2, 'passport_number' => 'NEW'])->assertNotFound();
    }

    public function test_identity_validates_impossible_and_future_dates_and_preserves_saved_birth_until_explicit_repair(): void
    {
        $payload = ['name' => 'تواريخ اصطناعية', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        foreach (['40002290100001', '30102310100001', '39901010100001', '3000229010000', '30002A90100001', 30002290100001] as $number) {
            $this->postJson("{$this->base}/students", [...$payload, 'national_id' => $number, 'date_of_birth' => '2000-02-29'])->assertUnprocessable()->assertJsonValidationErrors('national_id');
        }
        $this->postJson("{$this->base}/students", [...$payload, 'national_id' => '30002290100001'])->assertUnprocessable()->assertJsonValidationErrors('date_of_birth');
        $this->postJson("{$this->base}/students", [...$payload, 'passport_number' => 123])->assertUnprocessable()->assertJsonValidationErrors('passport_number');
        $student = $this->postJson("{$this->base}/students", [...$payload, 'date_of_birth' => '2000-03-01', 'passport_number' => '0'])->assertCreated()->json('student');
        $this->postJson("{$this->base}/students/identity-preview", ['student_id' => $student['id'], 'branch_ids' => [], 'national_id' => '30002290100001', 'date_of_birth' => '2000-03-01'])->assertOk()->assertJsonPath('conflict', true)->assertJsonPath('saved_date_of_birth', '2000-03-01');
        $edit = ['name' => $payload['name'], 'branch_ids' => [], 'revision' => 1, 'national_id' => '30002290100001'];
        $this->patchJson("{$this->base}/students/{$student['id']}", $edit)->assertUnprocessable()->assertJsonValidationErrors('date_of_birth');
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.date_of_birth', '2000-03-01')->assertJsonPath('students.0.identity.national_id', null);
        $this->patchJson("{$this->base}/students/{$student['id']}", [...$edit, 'date_of_birth' => '2000-02-29'])->assertOk()->assertJsonPath('student.revision', 2)->assertJsonPath('student.identity.passport_number', '0');
        $this->patchJson("{$this->base}/students/{$student['id']}", [...$edit, 'date_of_birth' => '2000-02-29'])->assertOk()->assertJsonPath('student.revision', 2);
        $this->patchJson("{$this->base}/students/{$student['id']}", [...$edit, 'national_id' => '30101010100001'])->assertConflict();
        $audit = collect($this->getJson("{$this->base}/audit")->assertOk()->assertDontSee('30002290100001')->json('entries'))->where('event', 'student.updated')->values();
        $this->assertCount(1, $audit);
        $this->assertSame(['national_id'], json_decode($audit[0]['details'], true)['identity_changed']);
    }

    public function test_existing_center_migration_preserves_requests_contacts_codes_and_identity_is_center_local(): void
    {
        $this->patchJson("{$this->base}/student-code-settings", ['enabled' => true, 'label' => 'كارت', 'revision' => 1])->assertOk();
        $contact = ['id' => (string) Str::uuid(), 'name' => 'صاحب البيانات الاصطناعية', 'relationship' => 'الطالب', 'phone' => '0001234', 'primary' => true];
        $payload = ['name' => 'ملف قديم', 'manual_code' => '000MIGRATION', 'branch_ids' => [$this->north], 'contacts' => [$contact], 'channels' => [], 'request_id' => (string) Str::uuid()];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->json('student');
        $this->center->run(function (): void {
            $path = glob(database_path('migrations/tenant/*_add_student_identity.php'))[0];
            (require $path)->down();
            DB::table('migrations')->where('migration', pathinfo($path, PATHINFO_FILENAME))->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $student['id'])->assertJsonPath('student.student_number', $student['student_number'])
            ->assertJsonPath('student.created_by', $student['created_by'])->assertJsonPath('student.created_at', $student['created_at'])->assertJsonPath('student.contacts.0.phone', '0001234')->assertJsonPath('student.manual_code', '000MIGRATION');
        $identity = ['national_id' => '30002290100001', 'date_of_birth' => '2000-02-29', 'passport_number' => '000A-SYNTHETIC'];
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => $student['name'], 'branch_ids' => [], 'revision' => 1, ...$identity])->assertOk()->assertJsonPath('student.identity.national_id', $identity['national_id']);
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')->postJson('http://courses.test/api/v1/platform/centers', ['name' => 'Beta', 'slug' => 'beta', 'subdomain' => 'beta', 'plan' => 'starter', 'owner_email' => 'owner@beta.test'])->assertCreated();
        $beta = Center::where('slug', 'beta')->firstOrFail();
        CenterMembership::create(['tenant_id' => $beta->id, 'user_id' => $this->owner->id, 'status' => 'active']);
        $beta->run(fn () => DB::table('center_grants')->insert(['user_id' => $this->owner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now()]));
        $this->actingAs($this->owner, 'web')->withSession(['center_id' => $beta->id]);
        $base = 'http://beta.courses.test/api/v1/center';
        $branch = $this->postJson("{$base}/branches", ['name' => 'Beta', 'slug' => 'beta'])->assertCreated()->json('branch.id');
        $this->postJson("{$base}/students", ['name' => 'هوية مستقلة بمركز آخر', 'branch_ids' => [$branch], 'request_id' => (string) Str::uuid(), ...$identity])->assertCreated();
        $this->getJson("{$base}/students/{$student['id']}")->assertNotFound();
    }

    public function test_identity_grant_never_implies_read_or_manage_and_old_replays_cannot_bypass_revocation(): void
    {
        $this->grant([$this->north => ['registration', 'student_identity']]);
        $this->asUser($this->staff);
        $payload = ['name' => 'إعادة اصطناعية', 'national_id' => '30002290100001', 'date_of_birth' => '2000-02-29', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->json('student');
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => $student['name'], 'branch_ids' => [], 'revision' => 1, 'national_id' => null])->assertOk();
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.identity.national_id', null);
        foreach (['attendance', 'accounting', 'branch_viewer'] as $role) {
            $this->grant([$this->north => [$role]]);
            $this->asUser($this->staff);
            $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonMissingPath('students.0.identity');
            $this->postJson("{$this->base}/students/identity-preview", ['student_id' => $student['id'], 'branch_ids' => [], 'national_id' => $payload['national_id']])->assertForbidden();
            $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => $student['name'], 'branch_ids' => [], 'revision' => 2, 'passport_number' => '0'])->assertForbidden();
        }
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $this->postJson("{$this->base}/students", $payload)->assertForbidden();
        $this->getJson("{$this->base}/students/submissions/{$payload['request_id']}")->assertOk()->assertJsonMissingPath('student.identity');
        $this->grant([$this->north => ['branch_viewer', 'student_identity']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.can_read_identity', true)->assertJsonPath('students.0.can_manage_identity', false);
        $this->postJson("{$this->base}/students/identity-preview", ['student_id' => $student['id'], 'branch_ids' => [], 'national_id' => $payload['national_id']])->assertForbidden();
        $this->asUser($this->owner);
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", ['center_roles' => [], 'branch_roles' => [$this->north => ['student_identity']]])->assertUnprocessable();
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
