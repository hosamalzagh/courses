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

class StudentCustomFieldsTest extends TestCase
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

    public function test_manager_defines_skillcard_and_registration_enters_shared_center_values(): void
    {
        $definition = ['id' => (string) Str::uuid(), 'label' => 'skillcard', 'type' => 'text', 'required' => true, 'position' => 10, 'options' => []];
        $field = $this->postJson("{$this->base}/student-custom-fields", $definition)->assertCreated()->json('field');
        $this->postJson("{$this->base}/student-custom-fields", $definition)->assertOk()->assertJsonPath('field.id', $field['id']);
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $this->postJson("{$this->base}/student-custom-fields", [...$definition, 'id' => (string) Str::uuid()])->assertForbidden();
        $this->getJson("{$this->base}/student-custom-fields?manage=1")->assertForbidden();
        $revision = $this->getJson("{$this->base}/student-workspace")->assertOk()->json('custom_fields.revision');
        $payload = ['name' => 'طالب حقول إضافية', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'custom_fields_revision' => $revision, 'custom_values' => [$field['id'] => '000SKILL']];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->assertJsonPath('student.custom_values.'.$field['id'], '000SKILL')->json('student');
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $student['id']);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.custom_values.'.$field['id'], '000SKILL')->assertJsonPath('students.0.missing_custom_fields', 0);
        $this->asUser($this->owner);
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => $student['name'], 'branch_ids' => [$this->south], 'revision' => 1])->assertOk();
        $this->grant([$this->south => ['registration', 'branch_auditor']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.custom_values.'.$field['id'], '000SKILL');
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'تعديل الفرع الآخر', 'branch_ids' => [], 'revision' => 2, 'custom_values' => [$field['id'] => 'NEW-SKILL'], 'custom_fields_revision' => $revision])->assertOk()->assertJsonPath('student.custom_values.'.$field['id'], 'NEW-SKILL');
        $this->getJson("{$this->base}/audit")->assertOk()->assertDontSee('000SKILL')->assertDontSee('NEW-SKILL');
    }

    public function test_types_requiredness_definition_revisions_and_independent_actions_preserve_old_profiles(): void
    {
        $old = $this->postJson("{$this->base}/students", ['name' => 'ملف سابق', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $fields = [];
        foreach (['text', 'number', 'date', 'select', 'boolean'] as $index => $type) {
            $fields[$type] = $this->postJson("{$this->base}/student-custom-fields", ['id' => (string) Str::uuid(), 'label' => $type, 'type' => $type, 'required' => true, 'position' => $index, 'options' => $type === 'select' ? ['أ', 'ب'] : []])->assertCreated()->json('field');
        }
        $workspace = $this->getJson("{$this->base}/students/{$old['id']}")->assertOk()->assertJsonPath('students.0.missing_custom_fields', 5)->json();
        $revision = $workspace['custom_fields']['revision'];
        $edit = ['name' => $old['name'], 'branch_ids' => [], 'revision' => 1];
        $this->patchJson("{$this->base}/students/{$old['id']}", $edit)->assertUnprocessable()->assertJsonValidationErrors('custom_values.'.$fields['text']['id']);
        $this->patchJson("{$this->base}/students/{$old['id']}/sharing", ['sharing_enabled' => ! $old['sharing_enabled'], 'revision' => 1])->assertOk()->assertJsonPath('student.missing_custom_fields', 5);
        $this->postJson("{$this->base}/students/{$old['id']}/status", ['status' => 'suspended', 'reason' => 'سبب مستقل', 'status_revision' => 1, 'request_id' => (string) Str::uuid()])->assertOk();
        $values = [$fields['text']['id'] => '000TXT', $fields['number']['id'] => '0', $fields['date']['id'] => '2000-02-29', $fields['select']['id'] => 'أ', $fields['boolean']['id'] => false];
        $payload = ['name' => 'طالب كامل', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'custom_fields_revision' => $revision, 'custom_values' => $values];
        foreach (['text' => ['x'], 'number' => 0, 'date' => '2001-02-29', 'select' => 'خارج القائمة', 'boolean' => 'false'] as $type => $bad) {
            $this->postJson("{$this->base}/students", [...$payload, 'custom_values' => array_replace($values, [$fields[$type]['id'] => $bad])])->assertUnprocessable()->assertJsonValidationErrors('custom_values.'.$fields[$type]['id']);
        }
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->assertJsonPath('student.custom_values.'.$fields['boolean']['id'], false)->assertJsonPath('student.custom_values.'.$fields['number']['id'], '0')->json('student');
        $change = ['label' => 'نص معدل', 'position' => 100, 'required' => true, 'revision' => 1];
        $this->patchJson("{$this->base}/student-custom-fields/{$fields['text']['id']}", $change)->assertOk()->assertJsonPath('field.revision', 2);
        $this->patchJson("{$this->base}/student-custom-fields/{$fields['text']['id']}", $change)->assertOk()->assertJsonPath('field.revision', 2);
        $this->patchJson("{$this->base}/student-custom-fields/{$fields['text']['id']}", [...$change, 'label' => 'قديم'])->assertConflict();
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'تعديل قديم', 'branch_ids' => [], 'revision' => 1, 'custom_values' => $values, 'custom_fields_revision' => $revision])->assertConflict();
        $latest = $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->json('custom_fields.revision');
        $changed = ['name' => 'تعديل حالي', 'branch_ids' => [], 'revision' => 1, 'custom_values' => [$fields['number']['id'] => '-12345678901234567890.1234567890'], 'custom_fields_revision' => $latest];
        $this->patchJson("{$this->base}/students/{$student['id']}", $changed)->assertOk()->assertJsonPath('student.revision', 2)->assertJsonPath('student.custom_values.'.$fields['text']['id'], '000TXT');
        $this->patchJson("{$this->base}/students/{$student['id']}", $changed)->assertOk()->assertJsonPath('student.revision', 2);
        $this->patchJson("{$this->base}/students/{$student['id']}", [...$changed, 'name' => 'قديم آخر'])->assertConflict();
    }

    public function test_bounded_fields_current_authority_and_old_center_migration_keep_profile_history_and_settings(): void
    {
        $contact = ['id' => (string) Str::uuid(), 'name' => 'الطالب', 'relationship' => 'نفسه', 'phone' => '0004567', 'primary' => true];
        $payload = ['name' => 'ملف سابق للترحيل', 'branch_ids' => [$this->north], 'contacts' => [$contact], 'channels' => [], 'passport_number' => '000BEFORE', 'request_id' => (string) Str::uuid()];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->json('student');
        $this->center->run(function (): void {
            $lifecycleMigration = glob(database_path('migrations/tenant/*_add_student_custom_field_lifecycle.php'))[0];
            (require $lifecycleMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($lifecycleMigration, PATHINFO_FILENAME))->delete();
            $path = glob(database_path('migrations/tenant/*_add_student_custom_fields.php'))[0];
            (require $path)->down();
            DB::table('migrations')->where('migration', pathinfo($path, PATHINFO_FILENAME))->delete();
            DB::table('center_settings')->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->getJson("{$this->base}/student-workspace")->assertOk()->assertJsonPath('student_code_settings.enabled', false)->assertJsonPath('student_code_settings.revision', 1)->assertJsonPath('custom_fields.revision', 1);
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $student['id'])->assertJsonPath('student.student_number', $student['student_number'])->assertJsonPath('student.created_at', $student['created_at'])->assertJsonPath('student.identity.passport_number', '000BEFORE')->assertJsonPath('student.contacts.0.phone', '0004567');
        $field = null;
        for ($index = 0; $index < 56; $index++) {
            $field = $this->postJson("{$this->base}/student-custom-fields", ['id' => (string) Str::uuid(), 'label' => 'حقل '.$index, 'type' => 'text', 'required' => false, 'position' => $index, 'options' => []])->assertCreated()->json('field');
        }
        $this->getJson("{$this->base}/student-custom-fields")->assertOk()->assertJsonCount(50, 'fields')->assertJsonPath('pagination.has_more', true);
        $this->getJson("{$this->base}/student-custom-fields?page=2")->assertOk()->assertJsonCount(6, 'fields')->assertJsonPath('pagination.has_more', false);
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => $student['name'], 'branch_ids' => [], 'revision' => 1, 'custom_values' => [$field['id'] => 'PAGE56']])->assertOk();
        $this->getJson("{$this->base}/student-custom-fields?page=2&student_id={$student['id']}")->assertOk()->assertJsonPath('values.'.$field['id'], 'PAGE56');
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertDontSee('PAGE56');
        $this->getJson("{$this->base}/student-workspace")->assertOk()->assertJsonMissingPath('students.0.custom_values');
        foreach ([[(string) Str::uuid() => 'خارج'], ['name' => 'التفاف']] as $values) {
            $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => $student['name'], 'branch_ids' => [], 'revision' => 2, 'custom_values' => $values])->assertUnprocessable();
        }
        $this->grant([$this->south => ['registration']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/student-custom-fields?page=2&student_id={$student['id']}")->assertNotFound();
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => $student['name'], 'branch_ids' => [], 'revision' => 2, 'custom_values' => [$field['id'] => 'DENIED']])->assertNotFound();
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/student-custom-fields?page=2&student_id={$student['id']}")->assertOk()->assertJsonPath('values.'.$field['id'], 'PAGE56');
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => $student['name'], 'branch_ids' => [], 'revision' => 2, 'custom_values' => [$field['id'] => 'DENIED']])->assertForbidden();
        $this->asUser($this->owner);
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", ['center_roles' => ['center_admin'], 'branch_roles' => []])->assertOk();
        $this->asUser($this->staff);
        $this->patchJson("{$this->base}/student-custom-fields/{$field['id']}", ['label' => 'تعريف المسؤول', 'required' => false, 'position' => 0, 'revision' => 1])->assertOk();
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $this->patchJson("{$this->base}/student-custom-fields/{$field['id']}", ['label' => 'تعريف غير مخول', 'required' => false, 'position' => 0, 'revision' => 2])->assertForbidden();
    }

    public function test_other_center_has_independent_definitions_and_values_and_custom_values_never_expand_discovery(): void
    {
        $field = $this->postJson("{$this->base}/student-custom-fields", ['id' => (string) Str::uuid(), 'label' => 'skillcard', 'type' => 'text', 'required' => false, 'position' => 0, 'options' => []])->assertCreated()->json('field');
        $student = $this->postJson("{$this->base}/students", ['name' => 'ملف خارج الفرع', 'branch_ids' => [$this->south], 'request_id' => (string) Str::uuid(), 'custom_values' => [$field['id'] => 'PRIVATE-CENTER-TEXT']])->assertCreated()->json('student');
        $policy = $this->getJson("{$this->base}/student-search-workspace")->assertOk()->json('policy');
        $this->patchJson("{$this->base}/student-search-policy", ['enabled' => true, 'default_sharing_enabled' => true, 'revision' => $policy['revision']])->assertOk();
        $this->patchJson("{$this->base}/students/{$student['id']}/sharing", ['sharing_enabled' => true, 'revision' => $student['revision']])->assertOk();
        $this->grant([$this->north => ['registration', 'center_student_search']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/student-search-workspace?q=".urlencode($student['name']))->assertOk()->assertDontSee('PRIVATE-CENTER-TEXT');
        $this->getJson("{$this->base}/students/similar?name=".urlencode($student['name']))->assertOk()->assertDontSee('PRIVATE-CENTER-TEXT');
        $this->getJson("{$this->base}/student-custom-fields?student_id={$student['id']}")->assertNotFound();
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')->postJson('http://courses.test/api/v1/platform/centers', ['name' => 'Beta', 'slug' => 'beta', 'subdomain' => 'beta', 'plan' => 'starter', 'owner_email' => 'owner@beta.test'])->assertCreated();
        $beta = Center::where('slug', 'beta')->firstOrFail();
        CenterMembership::create(['tenant_id' => $beta->id, 'user_id' => $this->owner->id, 'status' => 'active']);
        $beta->run(fn () => DB::table('center_grants')->insert(['user_id' => $this->owner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now()]));
        $this->actingAs($this->owner, 'web')->withSession(['center_id' => $beta->id]);
        $base = 'http://beta.courses.test/api/v1/center';
        $branch = $this->postJson("{$base}/branches", ['name' => 'Beta', 'slug' => 'beta'])->assertCreated()->json('branch.id');
        $this->getJson("{$base}/student-custom-fields")->assertOk()->assertJsonCount(0, 'fields')->assertJsonPath('revision', 1);
        $this->postJson("{$base}/students", ['name' => 'محاولة عبور', 'branch_ids' => [$branch], 'request_id' => (string) Str::uuid(), 'custom_values' => [$field['id'] => 'PRIVATE-CENTER-TEXT']])->assertUnprocessable();
        $this->postJson("{$base}/student-custom-fields", ['id' => $field['id'], 'label' => 'skillcard مختلف', 'type' => 'number', 'required' => true, 'position' => 0, 'options' => []])->assertCreated();
        $this->postJson("{$base}/students", ['name' => 'قيمة مستقلة', 'branch_ids' => [$branch], 'request_id' => (string) Str::uuid(), 'custom_values' => [$field['id'] => '0']])->assertCreated()->assertJsonPath('student.custom_values.'.$field['id'], '0');
        $this->getJson("{$base}/students/{$student['id']}")->assertNotFound();
    }

    public function test_custom_values_and_profile_rollback_together_when_audit_fails_then_same_request_can_retry(): void
    {
        $field = $this->postJson("{$this->base}/student-custom-fields", ['id' => (string) Str::uuid(), 'label' => 'skillcard', 'type' => 'text', 'required' => true, 'position' => 0, 'options' => []])->assertCreated()->json('field');
        $payload = ['name' => 'طلب ذري', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'custom_values' => [$field['id'] => 'ROLLBACK-CUSTOM']];
        $this->center->run(function (): void {
            DB::unprepared("CREATE FUNCTION fail_custom_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END; $$ LANGUAGE plpgsql");
            DB::unprepared('CREATE TRIGGER fail_custom_audit BEFORE INSERT ON center_audit_logs FOR EACH ROW EXECUTE FUNCTION fail_custom_audit()');
        });
        try {
            $this->postJson("{$this->base}/students", $payload)->assertStatus(500);
            $this->getJson("{$this->base}/students/submissions/{$payload['request_id']}")->assertNotFound();
            $this->getJson("{$this->base}/student-workspace?q=".urlencode($payload['name']))->assertOk()->assertJsonCount(0, 'students');
        } finally {
            $this->center->run(function (): void {
                DB::unprepared('DROP TRIGGER fail_custom_audit ON center_audit_logs');
                DB::unprepared('DROP FUNCTION fail_custom_audit()');
            });
        }
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->assertJsonPath('student.custom_values.'.$field['id'], 'ROLLBACK-CUSTOM')->json('student');
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $student['id']);
        $this->getJson("{$this->base}/students/{$student['id']}?tab=custom-history")->assertOk()->assertJsonCount(1, 'custom_history.entries')->assertJsonPath('custom_history.entries.0.value', 'ROLLBACK-CUSTOM');
        $this->getJson("{$this->base}/student-workspace?q=".urlencode($payload['name']))->assertOk()->assertJsonCount(1, 'students');
        $audit = collect($this->getJson("{$this->base}/audit")->assertOk()->assertDontSee('ROLLBACK-CUSTOM')->json('entries'))->where('event', 'student.created')->values();
        $this->assertCount(1, $audit);
        $this->assertSame([$field['id']], json_decode($audit[0]['details'], true)['custom_fields_changed']);
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
