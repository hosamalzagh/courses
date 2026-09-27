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

class StudentNumberingTest extends TestCase
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

    public function test_named_manual_codes_preserve_strings_and_survive_disabling_without_ambiguous_lookup(): void
    {
        $this->patchJson("{$this->base}/student-code-settings", ['enabled' => true, 'label' => 'كارت المركز', 'revision' => 1])->assertOk()
            ->assertJsonPath('settings.student_code_label', 'كارت المركز');
        $payload = ['name' => 'ملف بالكارت', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'manual_code' => '000A12'];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->assertJsonPath('student.manual_code', '000A12')->json('student');
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $student['id']);
        $this->getJson("{$this->base}/student-workspace?identifier=000A12")->assertOk()->assertJsonCount(1, 'students')->assertJsonPath('students.0.id', $student['id']);
        $this->patchJson("{$this->base}/student-code-settings", ['enabled' => false, 'label' => 'الكارت القديم', 'revision' => 2])->assertOk();
        $this->getJson("{$this->base}/student-workspace?identifier=000A12")->assertOk()->assertJsonCount(0, 'students');
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'تعديل عام', 'branch_ids' => [], 'revision' => 1])->assertOk()->assertJsonPath('student.manual_code', '000A12');
        $this->patchJson("{$this->base}/student-code-settings", ['enabled' => true, 'label' => 'الكارت القديم', 'revision' => 3])->assertOk();
        $this->getJson("{$this->base}/student-workspace?identifier=000A12")->assertOk()->assertJsonPath('students.0.id', $student['id']);
    }

    public function test_manual_code_conflicts_are_safe_and_future_sequence_collisions_fail_without_renumbering(): void
    {
        $this->patchJson("{$this->base}/student-code-settings", ['enabled' => true, 'label' => 'كارت', 'revision' => 1])->assertOk();
        $firstPayload = ['name' => 'محجوب لا يكشف', 'branch_ids' => [$this->south], 'request_id' => (string) Str::uuid(), 'manual_code' => '0005'];
        $first = $this->postJson("{$this->base}/students", $firstPayload)->assertCreated()->json('student');
        $secondPayload = ['name' => 'ثان', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $second = $this->postJson("{$this->base}/students", $secondPayload)->assertCreated()->json('student');
        $this->patchJson("{$this->base}/students/{$first['id']}", ['name' => $first['name'], 'branch_ids' => [], 'revision' => 1, 'manual_code' => '0002'])->assertUnprocessable()->assertJsonValidationErrors('manual_code')->assertDontSee('ثان');
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $this->postJson("{$this->base}/students", [...$secondPayload, 'request_id' => (string) Str::uuid(), 'manual_code' => '0005'])->assertUnprocessable()->assertJsonValidationErrors('manual_code')->assertDontSee($first['name']);
        $this->asUser($this->owner);
        $this->patchJson("{$this->base}/student-code-settings", ['enabled' => false, 'label' => 'كارت', 'revision' => 2])->assertOk();
        $this->patchJson("{$this->base}/student-numbering", ['start' => 5, 'revision' => 1])->assertOk();
        $next = [...$secondPayload, 'request_id' => (string) Str::uuid()];
        $this->postJson("{$this->base}/students", $next)->assertConflict()->assertJsonPath('code', 'student_number_code_collision')->assertDontSee($first['name']);
        $this->getJson("{$this->base}/students/submissions/{$next['request_id']}")->assertNotFound();
        $this->getJson("{$this->base}/students/{$first['id']}")->assertOk()->assertJsonPath('students.0.student_number', 1)->assertJsonPath('students.0.manual_code', '0005');
        $this->getJson("{$this->base}/students/{$second['id']}")->assertOk()->assertJsonPath('students.0.student_number', 2);
        $this->patchJson("{$this->base}/student-code-settings", ['enabled' => true, 'label' => 'كارت', 'revision' => 3])->assertOk();
        $this->patchJson("{$this->base}/students/{$first['id']}", ['name' => $first['name'], 'branch_ids' => [], 'revision' => 1, 'manual_code' => 'CARD-0005'])->assertOk();
        $this->postJson("{$this->base}/students", $next)->assertCreated()->assertJsonPath('student.student_number', 5);
    }

    public function test_scanned_identifier_wins_over_name_and_phone_matches_and_never_opens_a_hidden_profile(): void
    {
        $this->patchJson("{$this->base}/student-code-settings", ['enabled' => true, 'label' => 'كارت', 'revision' => 1])->assertOk();
        $payload = ['name' => 'صاحب الكارت', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'manual_code' => '000CARD'];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->json('student');
        $this->postJson("{$this->base}/students", ['name' => 'اسم يحتوي 000CARD', 'phone' => '0001', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->getJson("{$this->base}/student-workspace?identifier=000CARD")->assertOk()->assertJsonCount(1, 'students')->assertJsonPath('students.0.id', $student['id']);
        $this->getJson("{$this->base}/student-workspace?identifier=1")->assertOk()->assertJsonCount(1, 'students')->assertJsonPath('students.0.id', $student['id']);
        $this->getJson("{$this->base}/student-workspace?q=0001")->assertOk()->assertJsonCount(2, 'students');
        $this->grant([$this->south => ['attendance']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/student-workspace?identifier=000CARD")->assertOk()->assertJsonCount(0, 'students');
        $this->getJson("{$this->base}/student-workspace?identifier=1")->assertOk()->assertJsonCount(0, 'students');
    }

    public function test_manual_code_settings_and_writes_obey_current_grants_and_revisions(): void
    {
        $this->patchJson("{$this->base}/student-code-settings", ['enabled' => true, 'label' => 'كارت', 'revision' => 1])->assertOk();
        $this->patchJson("{$this->base}/student-code-settings", ['enabled' => false, 'label' => 'اسم آخر', 'revision' => 1])->assertConflict();
        $payload = ['name' => 'ترخيص الكارت', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'manual_code' => '0'];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->assertJsonPath('student.manual_code', '0')->json('student');
        $this->postJson("{$this->base}/students", [...$payload, 'request_id' => (string) Str::uuid(), 'manual_code' => 123])->assertUnprocessable();
        $this->grant([$this->north => ['attendance']]);
        $this->asUser($this->staff);
        $this->patchJson("{$this->base}/student-code-settings", ['enabled' => false, 'label' => 'تجاوز', 'revision' => 2])->assertForbidden();
        $edit = ['name' => $student['name'], 'branch_ids' => [], 'revision' => 1, 'manual_code' => '000XYZ'];
        $this->patchJson("{$this->base}/students/{$student['id']}", $edit)->assertForbidden();
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $this->patchJson("{$this->base}/students/{$student['id']}", $edit)->assertOk()->assertJsonPath('student.manual_code', '000XYZ');
        $this->patchJson("{$this->base}/students/{$student['id']}", [...$edit, 'manual_code' => 'قديم'])->assertConflict();
        $this->asUser($this->owner);
        $this->patchJson("{$this->base}/student-code-settings", ['enabled' => false, 'label' => 'كارت', 'revision' => 2])->assertOk();
        $this->patchJson("{$this->base}/students/{$student['id']}", [...$edit, 'revision' => 2, 'manual_code' => null])->assertUnprocessable()->assertJsonValidationErrors('manual_code');
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.manual_code', '000XYZ');
    }

    public function test_manual_code_migration_keeps_old_request_identity_history_and_sequence(): void
    {
        $payload = ['name' => 'قبل الكارت الإضافي', 'phone' => '000100', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->json('student');
        $this->center->run(function (): void {
            $migration = glob(database_path('migrations/tenant/*_add_student_manual_codes.php'))[0];
            (require $migration)->down();
            DB::table('migrations')->where('migration', pathinfo($migration, PATHINFO_FILENAME))->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $student['id'])
            ->assertJsonPath('student.student_number', 1)->assertJsonPath('student.legacy_phone', '000100')->assertJsonPath('student.manual_code', null)
            ->assertJsonPath('student.created_by', $student['created_by'])->assertJsonPath('student.created_at', $student['created_at']);
        $this->postJson("{$this->base}/students", [...$payload, 'request_id' => (string) Str::uuid()])->assertCreated()->assertJsonPath('student.student_number', 2);
        $this->patchJson("{$this->base}/student-code-settings", ['enabled' => true, 'label' => 'كارت', 'revision' => 1])->assertOk();
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => $student['name'], 'branch_ids' => [], 'revision' => 1,
            'manual_code' => '0004', 'manual_code_number' => 'SAFE'])->assertOk()->assertJsonPath('student.manual_code', '0004');
        $this->patchJson("{$this->base}/student-numbering", ['start' => 4, 'revision' => 1])->assertOk();
        $this->postJson("{$this->base}/students", [...$payload, 'request_id' => (string) Str::uuid()])->assertConflict()->assertJsonPath('code', 'student_number_code_collision');
    }

    public function test_sequence_start_is_center_wide_and_never_reuses_issued_numbers(): void
    {
        $this->patchJson("{$this->base}/student-numbering", ['start' => 500, 'revision' => 1])->assertOk();
        $payload = ['name' => 'First', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $first = $this->postJson("{$this->base}/students", $payload)->assertCreated()->json('student');
        $this->assertSame(500, $first['student_number']);
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $first['id'])->assertJsonPath('student.student_number', 500);
        $this->patchJson("{$this->base}/student-numbering", ['start' => 1, 'revision' => 2])->assertOk();
        $this->postJson("{$this->base}/students", [...$payload, 'name' => 'Second', 'branch_ids' => [$this->south], 'request_id' => (string) Str::uuid()])->assertCreated()->assertJsonPath('student.student_number', 501);
        $this->getJson("{$this->base}/students/{$first['id']}")->assertOk()->assertJsonPath('students.0.student_number', 500);
        $this->patchJson("{$this->base}/student-numbering", ['start' => 700, 'revision' => 2])->assertConflict();
        $this->getJson("{$this->base}/settings")->assertOk()->assertJsonPath('settings.student_number_start', 1)->assertJsonPath('settings.student_number_revision', 3);
    }

    public function test_print_and_scan_respect_branch_access_and_revoked_grants(): void
    {
        $student = $this->postJson("{$this->base}/students", ['name' => 'Private identity', 'phone' => '0123456789', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $print = $this->get("{$this->base}/students/{$student['id']}/barcode")->assertOk();
        $print->assertSee('<svg', false)->assertSee((string) $student['student_number'])->assertDontSee('Private identity')->assertDontSee('0123456789');
        $this->assertStringContainsString('no-store', $print->headers->get('Cache-Control'));
        $this->grant([$this->north => ['attendance']]);
        $this->asUser($this->staff);
        $this->get("{$this->base}/students/{$student['id']}/barcode")->assertOk();
        $this->getJson("{$this->base}/student-workspace?q={$student['student_number']}")->assertOk()->assertJsonPath('students.0.id', $student['id']);
        $this->patchJson("{$this->base}/student-numbering", ['start' => 100, 'revision' => 1])->assertForbidden();
        $this->grant([$this->south => ['attendance']]);
        $this->asUser($this->staff);
        $this->get("{$this->base}/students/{$student['id']}/barcode")->assertNotFound();
        $this->getJson("{$this->base}/student-workspace?q={$student['student_number']}")->assertOk()->assertJsonCount(0, 'students');
        $this->get("{$this->base}/students/not-a-uuid/barcode")->assertNotFound();
    }

    public function test_existing_center_migration_preserves_numbers_requests_and_sequence_high_water(): void
    {
        $path = database_path('migrations/tenant/2026_09_27_140330_add_student_numbering_settings.php');
        $payload = ['name' => 'Legacy student', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $this->postJson("{$this->base}/students", $payload)->assertCreated();
        $this->center->run(fn () => (require $path)->down());
        $this->center->run(fn () => DB::selectOne("SELECT nextval('students_student_number_seq')"));
        $legacy = $this->getJson("{$this->base}/students/submissions/{$payload['request_id']}")->assertOk()->json('student');
        $this->center->run(fn () => (require $path)->up());
        $this->getJson("{$this->base}/students/submissions/{$payload['request_id']}")->assertOk()->assertJsonPath('student.id', $legacy['id'])->assertJsonPath('student.student_number', 1);
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $legacy['id'])->assertJsonPath('student.student_number', 1);
        $this->postJson("{$this->base}/students", [...$payload, 'request_id' => (string) Str::uuid()])->assertCreated()->assertJsonPath('student.student_number', 3);
        $this->getJson("{$this->base}/user?include=settings")->assertOk()->assertJsonPath('settings.student_number_start', 1);
    }

    public function test_failed_creation_can_be_retried_without_partial_profile(): void
    {
        $payload = ['name' => 'Retried', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $this->center->run(function (): void {
            DB::unprepared("CREATE FUNCTION reject_student_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event = 'student.created' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$");
            DB::unprepared('CREATE TRIGGER reject_student_audit BEFORE INSERT ON center_audit_logs FOR EACH ROW EXECUTE FUNCTION reject_student_audit()');
        });
        $this->postJson("{$this->base}/students", $payload)->assertStatus(500);
        $this->getJson("{$this->base}/students/submissions/{$payload['request_id']}")->assertNotFound();
        $this->getJson("{$this->base}/student-workspace?q=Retried")->assertOk()->assertJsonCount(0, 'students');
        $this->center->run(fn () => DB::unprepared('DROP TRIGGER reject_student_audit ON center_audit_logs; DROP FUNCTION reject_student_audit()'));
        $saved = $this->postJson("{$this->base}/students", $payload)->assertCreated()->json('student');
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $saved['id'])->assertJsonPath('student.student_number', $saved['student_number']);
    }

    public function test_general_saves_preserve_numbering_and_setting_validation_is_server_enforced(): void
    {
        $this->patchJson("{$this->base}/student-numbering", ['start' => 1000, 'revision' => 1])->assertOk();
        $this->patchJson("{$this->base}/student-numbering", ['start' => 1000, 'revision' => 2])->assertOk()->assertJsonPath('settings.student_number_revision', 2);
        $this->patchJson("{$this->base}/settings", ['phone' => '01012345678'])->assertOk()->assertJsonPath('settings.student_number_start', 1000);
        $student = $this->postJson("{$this->base}/students", ['name' => 'Original', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'Edited', 'branch_ids' => [], 'revision' => 1])->assertOk()->assertJsonPath('student.student_number', 1000);
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'Edited', 'branch_ids' => [], 'revision' => 2, 'student_number' => 1])->assertUnprocessable();
        foreach ([0, -1, '1.5', 'not a number', 9007199254740992] as $start) {
            $this->patchJson("{$this->base}/student-numbering", ['start' => $start, 'revision' => 2])->assertUnprocessable();
        }
        $audit = collect($this->getJson("{$this->base}/audit")->assertOk()->json('entries'))->where('event', 'center.student_numbering_changed')->values();
        $this->assertCount(1, $audit);
        $this->assertSame(['before' => 1, 'after' => 1000], json_decode($audit[0]['details'], true));
        $response = $this->getJson("{$this->base}/user?include=settings")->assertOk();
        $this->assertGreaterThan(0, (int) $response->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $response->headers->get('X-Courses-Query-Count'));
    }

    public function test_sequence_exhaustion_fails_before_issuing_an_inexact_browser_identifier(): void
    {
        $this->patchJson("{$this->base}/student-numbering", ['start' => 9007199254740990, 'revision' => 1])->assertOk();
        $payload = ['name' => 'At supported limit', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()];
        $first = $this->postJson("{$this->base}/students", $payload)->assertCreated()->json('student');
        $this->assertSame(9007199254740990, $first['student_number']);
        $this->postJson("{$this->base}/students", [...$payload, 'request_id' => (string) Str::uuid()])->assertCreated()->assertJsonPath('student.student_number', 9007199254740991);
        $failedRequest = (string) Str::uuid();
        $this->postJson("{$this->base}/students", [...$payload, 'request_id' => $failedRequest])->assertConflict()->assertJsonPath('code', 'student_numbering_exhausted');
        $this->getJson("{$this->base}/students/submissions/{$failedRequest}")->assertNotFound();
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $first['id']);
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
