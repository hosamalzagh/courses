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

class StudentCustomFieldLifecycleTest extends TestCase
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

    public function test_disabled_field_and_option_preserve_old_values_without_accepting_new_use(): void
    {
        $field = $this->postJson("{$this->base}/student-custom-fields", ['id' => (string) Str::uuid(), 'label' => 'المسار الإضافي', 'type' => 'select', 'required' => true, 'position' => 0, 'options' => ['قديم', 'جديد']])->assertCreated()->json('field');
        $payload = ['name' => 'ملف سابق للاختيار', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'custom_values' => [$field['id'] => 'قديم']];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->json('student');
        $definition = ['label' => $field['label'], 'required' => true, 'position' => 0, 'revision' => 1, 'active' => true, 'disabled_options' => ['قديم']];
        $this->patchJson("{$this->base}/student-custom-fields/{$field['id']}", $definition)->assertOk()->assertJsonPath('field.disabled_options', ['قديم']);
        $this->postJson("{$this->base}/students", [...$payload, 'request_id' => (string) Str::uuid()])->assertUnprocessable()->assertJsonValidationErrors('custom_values.'.$field['id']);
        $edit = ['name' => 'تعديل عام يحفظ القديم', 'branch_ids' => [], 'revision' => 1, 'custom_values' => [$field['id'] => 'قديم']];
        $this->patchJson("{$this->base}/students/{$student['id']}", $edit)->assertOk()->assertJsonPath('student.custom_values.'.$field['id'], 'قديم');
        $this->patchJson("{$this->base}/students/{$student['id']}", [...$edit, 'name' => 'تغيير للجديد', 'revision' => 2, 'custom_values' => [$field['id'] => 'جديد']])->assertOk();
        $this->patchJson("{$this->base}/students/{$student['id']}", [...$edit, 'revision' => 3])->assertUnprocessable();
        $this->patchJson("{$this->base}/student-custom-fields/{$field['id']}", [...$definition, 'revision' => 2, 'active' => false])->assertOk()->assertJsonPath('field.active', false);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.custom_values.'.$field['id'], 'جديد')->assertJsonPath('students.0.missing_custom_fields', 0);
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'الحقل متوقف ومحفوظ', 'branch_ids' => [], 'revision' => 3])->assertOk();
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'محاولة تغيير متوقف', 'branch_ids' => [], 'revision' => 4, 'custom_values' => [$field['id'] => null]])->assertUnprocessable();
        $this->postJson("{$this->base}/students", ['name' => 'ملف جديد دون متوقف', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated();
    }

    public function test_used_type_is_immutable_and_value_history_keeps_versions_after_clear_and_disable(): void
    {
        $definition = ['id' => (string) Str::uuid(), 'label' => 'رقم خاص كنص', 'type' => 'text', 'required' => false, 'position' => 0, 'options' => []];
        $field = $this->postJson("{$this->base}/student-custom-fields", $definition)->assertCreated()->json('field');
        $create = ['name' => 'ملف تاريخ', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'custom_values' => [$field['id'] => '000OLD']];
        $student = $this->postJson("{$this->base}/students", $create)->assertCreated()->json('student');
        $this->postJson("{$this->base}/students", $create)->assertOk();
        $edit = ['name' => $student['name'], 'branch_ids' => [], 'revision' => 1, 'custom_values' => [$field['id'] => '000NEW']];
        $this->patchJson("{$this->base}/students/{$student['id']}", $edit)->assertOk();
        $this->patchJson("{$this->base}/students/{$student['id']}", $edit)->assertOk();
        $this->patchJson("{$this->base}/students/{$student['id']}", [...$edit, 'revision' => 2, 'custom_values' => [$field['id'] => null]])->assertOk();
        $changes = ['label' => $field['label'], 'required' => false, 'position' => 0, 'revision' => 1];
        $this->patchJson("{$this->base}/student-custom-fields/{$field['id']}", [...$changes, 'type' => 'number'])->assertUnprocessable()->assertJsonValidationErrors('type');
        $this->patchJson("{$this->base}/student-custom-fields/{$field['id']}", [...$changes, 'active' => false])->assertOk();
        $history = $this->getJson("{$this->base}/students/{$student['id']}?tab=custom-history")->assertOk()->assertJsonCount(3, 'custom_history.entries')->json('custom_history.entries');
        $this->assertSame([null, '000NEW', '000OLD'], array_column($history, 'value'));
        $this->assertSame([3, 2, 1], array_column($history, 'profile_revision'));
        $this->assertSame($this->owner->id, $history[0]['actor_id']);
        $this->assertSame('text', $history[2]['type']);
        $this->getJson("{$this->base}/audit")->assertOk()->assertDontSee('000OLD')->assertDontSee('000NEW');
        $unused = $this->postJson("{$this->base}/student-custom-fields", [...$definition, 'id' => (string) Str::uuid()])->assertCreated()->json('field');
        $this->patchJson("{$this->base}/student-custom-fields/{$unused['id']}", [...$changes, 'type' => 'number'])->assertOk()->assertJsonPath('field.type', 'number');
    }

    public function test_current_identity_classification_hides_values_and_history_and_general_edits_preserve_them(): void
    {
        $field = $this->postJson("{$this->base}/student-custom-fields", ['id' => (string) Str::uuid(), 'label' => 'هوية إضافية', 'type' => 'text', 'required' => false, 'position' => 0, 'options' => []])->assertCreated()->json('field');
        $student = $this->postJson("{$this->base}/students", ['name' => 'ملف نطاق الهوية', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'custom_values' => [$field['id'] => 'PRIVATE-CUSTOM-ID']])->assertCreated()->json('student');
        $definition = ['label' => $field['label'], 'required' => true, 'position' => 0, 'revision' => 1, 'classification' => 'identity'];
        $this->patchJson("{$this->base}/student-custom-fields/{$field['id']}", $definition)->assertOk()->assertJsonPath('field.classification', 'identity');
        $this->grant([$this->north => ['registration'], $this->south => ['registration', 'student_identity']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertDontSee('PRIVATE-CUSTOM-ID')->assertJsonMissingPath('students.0.custom_values.'.$field['id'])->assertJsonCount(0, 'custom_fields.fields');
        $this->getJson("{$this->base}/student-custom-fields?student_id={$student['id']}")->assertOk()->assertDontSee('PRIVATE-CUSTOM-ID')->assertJsonCount(0, 'fields');
        $this->getJson("{$this->base}/students/{$student['id']}?tab=custom-history")->assertOk()->assertDontSee('PRIVATE-CUSTOM-ID')->assertJsonCount(0, 'custom_history.entries');
        $edit = ['name' => 'تعديل عام', 'branch_ids' => [], 'revision' => 1];
        $this->patchJson("{$this->base}/students/{$student['id']}", [...$edit, 'custom_values' => [$field['id'] => null]])->assertForbidden()->assertDontSee('PRIVATE-CUSTOM-ID');
        $this->patchJson("{$this->base}/students/{$student['id']}", [...$edit, 'custom_values' => ['name' => 'unknown']])->assertUnprocessable()->assertJsonValidationErrors('custom_values');
        $this->patchJson("{$this->base}/students/{$student['id']}", $edit)->assertOk()->assertDontSee('PRIVATE-CUSTOM-ID');
        $this->postJson("{$this->base}/students", ['name' => 'نقص مقيد', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertUnprocessable()->assertJsonValidationErrors('custom_values')->assertJsonPath('errors.custom_values.0', fn ($message) => str_contains($message, 'موظف مخول'))->assertDontSee('PRIVATE-CUSTOM-ID');
        $this->grant([$this->north => ['registration', 'student_identity']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.custom_values.'.$field['id'], 'PRIVATE-CUSTOM-ID');
        $this->getJson("{$this->base}/students/{$student['id']}?tab=custom-history")->assertOk()->assertJsonPath('custom_history.entries.0.value', 'PRIVATE-CUSTOM-ID');
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'تعديل مخول', 'branch_ids' => [], 'revision' => 2, 'custom_values' => [$field['id'] => 'AUTHORIZED-ID']])->assertOk();
        $this->grant([$this->north => ['registration', 'branch_auditor']]);
        $this->asUser($this->staff);
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'صفحة قديمة', 'branch_ids' => [], 'revision' => 2, 'custom_values' => [$field['id'] => 'AUTHORIZED-ID']])->assertForbidden();
        $this->getJson("{$this->base}/students/{$student['id']}?tab=custom-history")->assertOk()->assertDontSee('PRIVATE-CUSTOM-ID')->assertDontSee('AUTHORIZED-ID')->assertJsonCount(0, 'custom_history.entries');
        $this->getJson("{$this->base}/audit")->assertOk()->assertDontSee('PRIVATE-CUSTOM-ID')->assertDontSee('AUTHORIZED-ID');
        $this->asUser($this->owner);
        $this->patchJson("{$this->base}/student-custom-fields/{$field['id']}", [...$definition, 'revision' => 2, 'active' => false])->assertOk();
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertDontSee('AUTHORIZED-ID');
    }

    public function test_existing_center_migration_preserves_latest_value_and_pages_only_available_history(): void
    {
        $field = $this->postJson("{$this->base}/student-custom-fields", ['id' => (string) Str::uuid(), 'label' => 'تاريخ قائم', 'type' => 'text', 'required' => false, 'position' => 0, 'options' => []])->assertCreated()->json('field');
        $create = ['name' => 'ملف قبل النسخ', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'custom_values' => [$field['id'] => 'PREVIOUS-SNAPSHOT'], 'passport_number' => '000MIGRATION'];
        $student = $this->postJson("{$this->base}/students", $create)->assertCreated()->json('student');
        $this->center->run(function (): void {
            $path = glob(database_path('migrations/tenant/*_add_student_custom_field_lifecycle.php'))[0];
            (require $path)->down();
            DB::table('migrations')->where('migration', pathinfo($path, PATHINFO_FILENAME))->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->postJson("{$this->base}/students", $create)->assertOk()->assertJsonPath('student.id', $student['id'])->assertJsonPath('student.student_number', $student['student_number'])->assertJsonPath('student.identity.passport_number', '000MIGRATION');
        $this->getJson("{$this->base}/students/{$student['id']}?tab=custom-history")->assertOk()->assertJsonCount(1, 'custom_history.entries')->assertJsonPath('custom_history.entries.0.imported', true)->assertJsonPath('custom_history.entries.0.actor_id', null)->assertJsonPath('custom_history.entries.0.value', 'PREVIOUS-SNAPSHOT');
        for ($revision = 1; $revision <= 55; $revision++) {
            $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => $student['name'], 'branch_ids' => [], 'revision' => $revision, 'custom_values' => [$field['id'] => 'VERSION-'.$revision]])->assertOk();
        }
        $first = $this->getJson("{$this->base}/students/{$student['id']}?tab=custom-history")->assertOk()->assertJsonCount(50, 'custom_history.entries')->assertJsonPath('custom_history.pagination.has_more', true)->assertJsonPath('custom_history.entries.0.value', 'VERSION-55');
        $this->assertLessThanOrEqual(6, (int) $first->headers->get('X-Courses-Query-Count'));
        $this->assertNotNull($first->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$this->base}/students/{$student['id']}?tab=custom-history&custom_history_page=2")->assertOk()->assertJsonCount(6, 'custom_history.entries')->assertJsonPath('custom_history.pagination.has_more', false)->assertJsonPath('custom_history.entries.5.value', 'PREVIOUS-SNAPSHOT');
        $this->getJson("{$this->base}/student-custom-fields/{$field['id']}")->assertOk()->assertJsonPath('field.used', true)->assertJsonPath('field.classification', 'general');
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
