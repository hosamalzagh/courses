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

    public function test_profile_numbering_sharing_and_suspension_preserve_each_other_across_retries_and_edits(): void
    {
        $this->patchJson("{$this->base}/student-numbering", ['start' => 7000, 'revision' => 1])->assertOk();
        $this->patchJson("{$this->base}/student-search-policy", ['default_sharing_enabled' => true, 'enabled' => true, 'revision' => 1])->assertOk();
        $creation = ['name' => 'طالب التكامل', 'phone' => '01070007000', 'date_of_birth' => '2000-01-01', 'school' => 'مدرسة التكامل', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $student = $this->postJson("{$this->base}/students", $creation)->assertCreated()
            ->assertJsonPath('student.student_number', 7000)->assertJsonPath('student.sharing_enabled', true)
            ->assertJsonPath('student.status', 'active')->json('student');
        $route = "{$this->base}/students/{$student['id']}";
        $this->patchJson("{$route}/sharing", ['sharing_enabled' => false, 'revision' => 1])->assertOk()
            ->assertJsonPath('student.school', 'مدرسة التكامل')->assertJsonPath('student.student_number', 7000);
        $suspension = ['status' => 'suspended', 'reason' => 'سبب التكامل', 'status_revision' => 1, 'request_id' => (string) Str::uuid()];
        $this->postJson("{$route}/status", $suspension)->assertOk();
        $this->postJson("{$route}/status", $suspension)->assertOk();
        $this->patchJson($route, ['name' => 'طالب التكامل المعدل', 'phone' => $creation['phone'], 'school' => 'مدرسة معدلة', 'branch_ids' => [], 'revision' => 1])->assertConflict();
        $this->patchJson($route, ['name' => 'طالب التكامل المعدل', 'phone' => $creation['phone'], 'school' => 'مدرسة معدلة', 'branch_ids' => [], 'revision' => 2])->assertOk()
            ->assertJsonPath('student.student_number', 7000)->assertJsonPath('student.sharing_enabled', false)
            ->assertJsonPath('student.status', 'suspended')->assertJsonPath('student.status_revision', 2)
            ->assertJsonPath('student.date_of_birth', '2000-01-01')->assertJsonPath('student.school', 'مدرسة معدلة');
        $this->postJson("{$this->base}/students", $creation)->assertOk()
            ->assertJsonPath('student.id', $student['id'])->assertJsonPath('student.school', 'مدرسة معدلة')
            ->assertJsonPath('student.student_number', 7000)->assertJsonPath('student.status', 'suspended');
        $this->getJson("{$route}/barcode")->assertOk()->assertSee('7000')->assertDontSee('مدرسة معدلة');
        $this->postJson("{$route}/status", ['status' => 'active', 'reason' => 'فك إيقاف التكامل', 'status_revision' => 2, 'request_id' => (string) Str::uuid()])->assertOk();
        $this->getJson($route)->assertOk()->assertJsonPath('students.0.status', 'active')
            ->assertJsonPath('students.0.sharing_enabled', false)->assertJsonPath('students.0.revision', 3)
            ->assertJsonCount(1, 'suspensions');
        $this->postJson("{$this->base}/students", [...$creation, 'name' => 'طالب تالٍ', 'request_id' => (string) Str::uuid()])->assertCreated()->assertJsonPath('student.student_number', 7001);
    }

    public function test_contacts_and_owned_channels_keep_shared_numbers_and_retry_without_duplicate_profiles(): void
    {
        $contact = ['id' => (string) Str::uuid(), 'name' => 'الأم', 'relationship' => 'والدة', 'phone' => '001234', 'primary' => true];
        $other = ['id' => (string) Str::uuid(), 'name' => 'الطالب', 'relationship' => 'الطالب نفسه', 'phone' => '005678', 'primary' => false];
        $channels = ['primary' => ['contact_id' => $contact['id'], 'phone' => '001234'], 'alternative' => ['contact_id' => $other['id'], 'phone' => '005678'], 'whatsapp' => ['contact_id' => $contact['id'], 'phone' => '001234'], 'sinjapp' => ['contact_id' => $other['id'], 'phone' => '005678']];
        $payload = ['name' => 'طالب بالغ', 'branch_ids' => [$this->north], 'contacts' => [$contact, $other], 'channels' => $channels, 'request_id' => (string) Str::uuid()];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()
            ->assertJsonPath('student.contacts.0.name', 'الأم')->assertJsonPath('student.channels.sinjapp.contact_id', $other['id'])
            ->assertJsonPath('student.phone', '001234')->assertJsonPath('student.legacy_phone', null)->json('student');
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $student['id']);
        $this->postJson("{$this->base}/students", [...$payload, 'name' => 'الأخ', 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->getJson("{$this->base}/students/similar?phone=001234")->assertOk()->assertJsonCount(2, 'students');
        $this->getJson("{$this->base}/student-workspace?q=005678")->assertOk()->assertJsonCount(2, 'students');
        $this->getJson("{$this->base}/students/similar?phones[]=9999&phones[]=005678")->assertOk()->assertJsonCount(2, 'students');
        // Only the provisioning invitation from setUp; contacts send no additional mail.
        Mail::assertSentCount(1);
        Mail::assertNothingQueued();
    }

    public function test_contact_edits_preserve_legacy_numbers_and_reject_stale_or_unauthorized_changes(): void
    {
        $old = ['name' => 'رقم قديم', 'phone' => '000111', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $student = $this->postJson("{$this->base}/students", $old)->assertCreated()->assertJsonPath('student.contacts', [])->json('student');
        $route = "{$this->base}/students/{$student['id']}";
        $contact = ['id' => (string) Str::uuid(), 'name' => 'الطالب نفسه', 'relationship' => 'الطالب', 'phone' => '000222', 'primary' => true];
        $edit = ['name' => $student['name'], 'phone' => '000111', 'branch_ids' => [], 'revision' => 1, 'contacts' => [$contact], 'channels' => []];
        $this->patchJson($route, $edit)->assertOk()->assertJsonPath('student.phone', '000222')->assertJsonPath('student.legacy_phone', '000111');
        $this->patchJson($route, $edit)->assertOk()->assertJsonPath('student.revision', 2);
        $this->patchJson($route, [...$edit, 'contacts' => [[...$contact, 'phone' => '000333']]])->assertConflict();
        $this->postJson("{$this->base}/students", $old)->assertOk()->assertJsonPath('student.id', $student['id']);
        $this->getJson("{$this->base}/student-workspace?q=000111")->assertOk()->assertJsonCount(1, 'students');
        // Older callers may update other fields; omission never erases the migrated number or contacts.
        $this->patchJson($route, ['name' => 'اسم معدل', 'branch_ids' => [], 'revision' => 2])->assertOk()
            ->assertJsonPath('student.legacy_phone', '000111')->assertJsonPath('student.contacts.0.phone', '000222');
        $this->grant([$this->south => ['registration']]);
        $this->asUser($this->staff);
        $this->patchJson($route, [...$edit, 'revision' => 3])->assertNotFound();
        $this->grant([$this->north => ['attendance']]);
        $this->asUser($this->staff);
        $this->patchJson($route, [...$edit, 'revision' => 3])->assertForbidden();
        $this->asUser($this->owner);
        $this->getJson($route)->assertOk()->assertJsonPath('students.0.contacts.0.phone', '000222');
    }

    public function test_contact_validation_rejects_ambiguous_primary_and_foreign_or_unowned_channels(): void
    {
        $contact = ['id' => (string) Str::uuid(), 'name' => 'جهة', 'relationship' => 'قريب', 'phone' => '0', 'primary' => true];
        $payload = ['name' => 'تحقق', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'contacts' => [$contact], 'channels' => []];
        $this->postJson("{$this->base}/students", [...$payload, 'contacts' => [[...$contact, 'primary' => false]]])->assertUnprocessable()->assertJsonValidationErrors('contacts');
        $this->postJson("{$this->base}/students", [...$payload, 'contacts' => [$contact, [...$contact, 'id' => (string) Str::uuid()]]])->assertUnprocessable();
        $this->postJson("{$this->base}/students", [...$payload, 'channels' => ['whatsapp' => ['contact_id' => (string) Str::uuid(), 'phone' => '0000']]])->assertUnprocessable()->assertJsonValidationErrors('channels.whatsapp.contact_id');
        $this->postJson("{$this->base}/students", [...$payload, 'channels' => ['whatsapp' => ['phone' => '0000']]])->assertUnprocessable();
        $this->postJson("{$this->base}/students", [...$payload, 'contacts' => [[...$contact, 'phone' => 123]]])->assertUnprocessable();
        $this->postJson("{$this->base}/students", [...$payload, 'contacts' => [[...$contact, 'phone' => 'abc']]])->assertUnprocessable()->assertJsonValidationErrors('contacts.0.phone');
        $this->postJson("{$this->base}/students", $payload)->assertCreated()->assertJsonPath('student.phone', '0');
    }

    public function test_contact_migration_preserves_existing_identity_history_requests_and_unassigned_phone(): void
    {
        $payload = ['name' => 'قبل ترحيل التواصل', 'phone' => '0000456', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->json('student');
        $this->center->run(function (): void {
            $migration = glob(database_path('migrations/tenant/*_add_student_contacts.php'))[0];
            (require $migration)->down();
            DB::table('migrations')->where('migration', pathinfo($migration, PATHINFO_FILENAME))->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $student['id'])
            ->assertJsonPath('student.student_number', $student['student_number'])->assertJsonPath('student.created_by', $student['created_by'])
            ->assertJsonPath('student.created_at', $student['created_at'])->assertJsonPath('student.contacts', [])->assertJsonPath('student.legacy_phone', '0000456');
        $this->getJson("{$this->base}/students/similar?phone=0000456")->assertOk()->assertJsonCount(1, 'students');
        $entries = collect($this->getJson("{$this->base}/audit")->assertOk()->json('entries'))->where('event', 'student.created');
        $this->assertCount(1, $entries);
    }

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
            $waitlistMigration = glob(database_path('migrations/tenant/*_create_study_attempt_waitlists.php'))[0];
            (require $waitlistMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($waitlistMigration, PATHINFO_FILENAME))->delete();
            $attendanceMigration = glob(database_path('migrations/tenant/*_create_study_attendance.php'))[0];
            (require $attendanceMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($attendanceMigration, PATHINFO_FILENAME))->delete();
            $notesMigration = glob(database_path('migrations/tenant/*_create_student_event_notes.php'))[0];
            (require $notesMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($notesMigration, PATHINFO_FILENAME))->delete();
            $allocationsMigration = glob(database_path('migrations/tenant/*_create_student_payment_allocations.php'))[0];
            (require $allocationsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($allocationsMigration, PATHINFO_FILENAME))->delete();
            $withdrawalsMigration = glob(database_path('migrations/tenant/*_add_study_attempt_withdrawals_and_repeats.php'))[0];
            (require $withdrawalsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($withdrawalsMigration, PATHINFO_FILENAME))->delete();
            $attemptsMigration = glob(database_path('migrations/tenant/*_create_study_attempts.php'))[0];
            (require $attemptsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($attemptsMigration, PATHINFO_FILENAME))->delete();
            $financeMigration = glob(database_path('migrations/tenant/*_create_student_financial_accounts.php'))[0];
            (require $financeMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($financeMigration, PATHINFO_FILENAME))->delete();
            $versionsMigration = glob(database_path('migrations/tenant/*_version_student_attachments.php'))[0];
            (require $versionsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($versionsMigration, PATHINFO_FILENAME))->delete();
            $attachmentsMigration = glob(database_path('migrations/tenant/*_create_student_attachments.php'))[0];
            (require $attachmentsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($attachmentsMigration, PATHINFO_FILENAME))->delete();
            $photosMigration = glob(database_path('migrations/tenant/*_add_student_photos.php'))[0];
            (require $photosMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($photosMigration, PATHINFO_FILENAME))->delete();
            $lifecycleMigration = glob(database_path('migrations/tenant/*_add_student_custom_field_lifecycle.php'))[0];
            (require $lifecycleMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($lifecycleMigration, PATHINFO_FILENAME))->delete();
            $customMigration = glob(database_path('migrations/tenant/*_add_student_custom_fields.php'))[0];
            (require $customMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($customMigration, PATHINFO_FILENAME))->delete();
            $identityMigration = glob(database_path('migrations/tenant/*_add_student_identity.php'))[0];
            (require $identityMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($identityMigration, PATHINFO_FILENAME))->delete();
            $codesMigration = glob(database_path('migrations/tenant/*_add_student_manual_codes.php'))[0];
            (require $codesMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($codesMigration, PATHINFO_FILENAME))->delete();
            $contactsMigration = glob(database_path('migrations/tenant/*_add_student_contacts.php'))[0];
            (require $contactsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($contactsMigration, PATHINFO_FILENAME))->delete();
            $choicesMigration = glob(database_path('migrations/tenant/*_create_student_profile_choices.php'))[0];
            (require $choicesMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($choicesMigration, PATHINFO_FILENAME))->delete();
            $migration = glob(database_path('migrations/tenant/*_add_student_cross_branch_sharing.php'))[0];
            (require $migration)->down();
            DB::table('migrations')->where('migration', pathinfo($migration, PATHINFO_FILENAME))->delete();
            DB::statement('DROP TABLE student_suspensions');
            DB::table('migrations')->where('migration', '2026_09_27_140230_add_student_suspension_history')->delete();
            DB::statement('DROP TABLE student_branches');
            DB::statement('DROP TABLE students');
            DB::table('migrations')->whereIn('migration', ['2026_09_26_193307_create_student_profiles', '2026_09_27_140402_add_general_student_profile_fields'])->delete();
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

    public function test_general_profile_fields_are_optional_persistent_and_age_is_derived_on_birthday(): void
    {
        $this->travelTo(now()->setDate(2026, 9, 26));
        $student = $this->createStudent('طفل', [$this->north]);
        $this->assertNull($student['date_of_birth']);
        $payload = ['name' => 'طفل', 'branch_ids' => [], 'revision' => 1,
            'date_of_birth' => '2016-09-27', 'gender' => 'female', 'address' => 'العنوان',
            'email' => 'student@example.test', 'school' => 'مدرسة', 'employer' => 'جهة العمل', 'specialization' => 'التخصص'];
        $this->patchJson("{$this->base}/students/{$student['id']}", $payload)->assertOk()
            ->assertJsonPath('student.age', 9)->assertJsonPath('student.school', 'مدرسة')
            ->assertJsonPath('student.student_number', $student['student_number']);
        $this->travelTo(now()->setDate(2026, 9, 27));
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()
            ->assertJsonPath('students.0.age', 10)->assertJsonPath('students.0.employer', 'جهة العمل')
            ->assertJsonPath('students.0.created_by', $this->owner->id);
        $this->patchJson("{$this->base}/students/{$student['id']}", [...$payload, 'revision' => 1, 'school' => 'تعديل قديم'])
            ->assertConflict();
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'اسم جديد', 'branch_ids' => [], 'revision' => 2])
            ->assertOk()->assertJsonPath('student.school', 'مدرسة')->assertJsonPath('student.date_of_birth', '2016-09-27');
    }

    public function test_birth_date_and_general_fields_reject_invalid_values_without_changing_the_profile(): void
    {
        $this->travelTo(now()->setDate(2026, 9, 27));
        foreach (['2026-09-28', '2025-02-29', '2016-13-01', '27/09/2016', '0000-01-01'] as $date) {
            $this->postJson("{$this->base}/students", ['name' => 'طالب', 'branch_ids' => [$this->north],
                'request_id' => (string) Str::uuid(), 'date_of_birth' => $date])->assertUnprocessable()->assertJsonValidationErrors('date_of_birth');
        }
        $student = $this->postJson("{$this->base}/students", ['name' => 'مولود اليوم', 'branch_ids' => [$this->north],
            'request_id' => (string) Str::uuid(), 'date_of_birth' => '2026-09-27'])->assertCreated()->assertJsonPath('student.age', 0)->json('student');
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'طالب', 'branch_ids' => [], 'revision' => 1,
            'email' => 'invalid', 'gender' => 'unknown'])->assertUnprocessable()->assertJsonValidationErrors(['email', 'gender']);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.name', 'مولود اليوم');
    }

    public function test_expanding_an_existing_center_preserves_numbers_contacts_associations_audit_and_requests(): void
    {
        $requestId = (string) Str::uuid();
        $payload = ['name' => 'ملف قديم', 'phone' => '01012345678', 'branch_ids' => [$this->north, $this->south], 'request_id' => $requestId];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->json('student');
        $this->center->run(function (): void {
            $migration = require database_path('migrations/tenant/2026_09_27_140402_add_general_student_profile_fields.php');
            $migration->down();
            DB::table('migrations')->where('migration', '2026_09_27_140402_add_general_student_profile_fields')->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $student['id']);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()
            ->assertJsonPath('students.0.student_number', $student['student_number'])
            ->assertJsonPath('students.0.phone', '01012345678')
            ->assertJsonPath('students.0.branch_ids', [$this->north, $this->south])
            ->assertJsonPath('students.0.created_by', $student['created_by'])
            ->assertJsonPath('students.0.created_at', $student['created_at'])
            ->assertJsonPath('students.0.date_of_birth', null);
        $events = collect($this->getJson("{$this->base}/audit")->assertOk()->json('entries'))->where('event', 'student.created');
        $this->assertCount(2, $events);
        $this->getJson("{$this->base}/students/submissions/{$requestId}")->assertOk()->assertJsonPath('student.id', $student['id']);
    }

    public function test_leap_day_birthdays_and_nullable_birth_dates_have_no_stored_age(): void
    {
        $this->travelTo(now()->setDate(2024, 2, 28));
        $student = $this->postJson("{$this->base}/students", ['name' => 'ميلاد كبيس', 'branch_ids' => [$this->north],
            'request_id' => (string) Str::uuid(), 'date_of_birth' => '2020-02-29'])->assertCreated()->assertJsonPath('student.age', 3)->json('student');
        $this->travelTo(now()->setDate(2024, 2, 29));
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.age', 4);
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => $student['name'], 'branch_ids' => [], 'revision' => 1,
            'date_of_birth' => null, 'created_by' => $this->staff->id, 'created_at' => '1999-01-01', 'age' => 99])->assertOk()
            ->assertJsonPath('student.age', null)->assertJsonPath('student.created_by', $this->owner->id);
    }

    public function test_registration_can_edit_shared_general_data_without_managing_every_visible_branch(): void
    {
        $student = $this->createStudent('فروع متعددة', [$this->north, $this->south]);
        $this->grant([$this->north => ['registration'], $this->south => ['attendance']]);
        $this->asUser($this->staff);
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => $student['name'], 'branch_ids' => [$this->north],
            'revision' => 1, 'school' => 'مدرسة معدلة'])->assertOk()
            ->assertJsonPath('student.school', 'مدرسة معدلة')->assertJsonPath('student.branch_ids', [$this->north, $this->south]);
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
