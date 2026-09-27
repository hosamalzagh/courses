<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class StudentPhotoTest extends TestCase
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

    public function test_staff_uploads_and_replaces_a_photo_without_changing_profile_data_and_retries_once(): void
    {
        $student = $this->postJson("{$this->base}/students", ['name' => 'طالب الصورة', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(), 'passport_number' => 'KEEP-PRIVATE-PASSPORT', 'employer' => 'جهة محفوظة'])->assertCreated()->json('student');
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $requestId = (string) Str::uuid();
        $payload = ['photo' => $this->image(), 'request_id' => $requestId, 'photo_revision' => 1];
        $result = $this->post("{$this->base}/students/{$student['id']}/photo", $payload, ['Accept' => 'application/json'])->assertCreated();
        $result->assertJsonPath('photo_revision', 2);
        $photo = $result->json('photo');
        $this->assertStringStartsWith('data:image/jpeg;base64,', $photo['preview']);
        $this->get('http://alpha.courses.test'.$photo['url'])->assertOk()->assertHeader('Cache-Control', 'no-store, private');
        $this->post("{$this->base}/students/{$student['id']}/photo", [...$payload, 'photo' => $this->image()], ['Accept' => 'application/json'])->assertOk()->assertJsonPath('photo.id', $photo['id'])->assertJsonPath('photo_revision', 2);
        $this->post("{$this->base}/students/{$student['id']}/photo", ['photo' => $this->image(), 'request_id' => (string) Str::uuid(), 'photo_revision' => 1], ['Accept' => 'application/json'])->assertConflict();
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.name', 'طالب الصورة')->assertJsonPath('students.0.employer', 'جهة محفوظة')->assertJsonPath('students.0.revision', 1)->assertJsonPath('students.0.photo.id', $photo['id']);
        $replacement = $this->post("{$this->base}/students/{$student['id']}/photo", ['photo' => $this->image(), 'request_id' => (string) Str::uuid(), 'photo_revision' => 2], ['Accept' => 'application/json'])->assertCreated()->assertJsonPath('photo_revision', 3);
        $this->assertNotSame($photo['id'], $replacement->json('photo.id'));
        $this->get('http://alpha.courses.test'.$photo['url'])->assertNotFound();
        $this->get('http://alpha.courses.test'.$replacement->json('photo.url'))->assertOk();
        $this->asUser($this->owner);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.identity.passport_number', 'KEEP-PRIVATE-PASSPORT');
    }

    public function test_invalid_oversized_partial_and_attachment_promotions_preserve_the_last_complete_photo(): void
    {
        $student = $this->postJson("{$this->base}/students", ['name' => 'الصورة الحالية', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $photo = $this->post("{$this->base}/students/{$student['id']}/photo", ['photo' => $this->image(), 'request_id' => (string) Str::uuid(), 'photo_revision' => 1], ['Accept' => 'application/json'])->assertCreated()->json('photo');
        $forged = tempnam(sys_get_temp_dir(), 'courses-photo-');
        file_put_contents($forged, '<?php echo "not an image";');
        $oversized = $this->image();
        file_put_contents($oversized->getRealPath(), str_repeat('x', 10 * 1024 * 1024), FILE_APPEND);
        $partial = $this->image();
        foreach ([new UploadedFile($forged, 'student.png', 'image/png', null, true), $oversized, new UploadedFile($partial->getRealPath(), 'student.png', 'image/png', UPLOAD_ERR_PARTIAL, true)] as $invalid) {
            $this->post("{$this->base}/students/{$student['id']}/photo", ['photo' => $invalid, 'request_id' => (string) Str::uuid(), 'photo_revision' => 2], ['Accept' => 'application/json'])->assertUnprocessable()->assertJsonValidationErrors('photo');
        }
        $this->post("{$this->base}/students/{$student['id']}/photo", ['photo' => $this->image(), 'request_id' => (string) Str::uuid(), 'photo_revision' => 2, 'attachment_id' => (string) Str::uuid(), 'classification' => 'identity', 'path' => 'private/identity-document'], ['Accept' => 'application/json'])->assertUnprocessable()->assertJsonValidationErrors(['attachment_id', 'classification', 'path']);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.photo.id', $photo['id'])->assertJsonPath('students.0.photo_revision', 2)->assertJsonPath('students.0.revision', 1);
        $this->get('http://alpha.courses.test'.$photo['url'])->assertOk()->assertHeader('Content-Type', 'image/png');
    }

    public function test_photo_read_and_write_follow_current_membership_branch_and_center_without_identity_grants(): void
    {
        $student = $this->postJson("{$this->base}/students", ['name' => 'صلاحيات الصورة', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $photo = $this->post("{$this->base}/students/{$student['id']}/photo", ['photo' => $this->image(), 'request_id' => (string) Str::uuid(), 'photo_revision' => 1], ['Accept' => 'application/json'])->assertCreated()->json('photo');
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $read = $this->get('http://alpha.courses.test'.$photo['url'])->assertOk()->assertHeader('Cache-Control', 'no-store, private');
        $this->assertNotNull($read->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $read->headers->get('X-Courses-Query-Count'));
        $this->post("{$this->base}/students/{$student['id']}/photo", ['photo' => $this->image(), 'request_id' => (string) Str::uuid(), 'photo_revision' => 2], ['Accept' => 'application/json'])->assertNotFound();
        $this->grant([$this->south => ['registration', 'student_identity']]);
        $this->asUser($this->staff);
        $this->get('http://alpha.courses.test'.$photo['url'])->assertNotFound();
        $this->getJson("{$this->base}/students/{$student['id']}")->assertNotFound();
        $this->post("{$this->base}/students/{$student['id']}/photo", ['photo' => $this->image(), 'request_id' => (string) Str::uuid(), 'photo_revision' => 2], ['Accept' => 'application/json'])->assertNotFound();
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $this->membership->update(['status' => 'suspended']);
        $this->get('http://alpha.courses.test'.$photo['url'])->assertForbidden();
        $this->post("{$this->base}/students/{$student['id']}/photo", ['photo' => $this->image(), 'request_id' => (string) Str::uuid(), 'photo_revision' => 2], ['Accept' => 'application/json'])->assertForbidden();
    }

    public function test_failed_audit_rolls_back_photo_publication_and_the_same_request_can_retry_without_duplicates(): void
    {
        $student = $this->postJson("{$this->base}/students", ['name' => 'صورة ذرية', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $first = $this->post("{$this->base}/students/{$student['id']}/photo", ['photo' => $this->image(), 'request_id' => (string) Str::uuid(), 'photo_revision' => 1], ['Accept' => 'application/json'])->assertCreated()->json('photo');
        $requestId = (string) Str::uuid();
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT photo_acceptance_failure CHECK (event <> 'student.photo_changed') NOT VALID"));
        try {
            $this->post("{$this->base}/students/{$student['id']}/photo", ['photo' => $this->image(), 'request_id' => $requestId, 'photo_revision' => 2], ['Accept' => 'application/json'])->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT photo_acceptance_failure'));
        }
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.photo.id', $first['id'])->assertJsonPath('students.0.photo_revision', 2);
        $this->get("{$this->base}/students/{$student['id']}/photo/{$requestId}")->assertNotFound();
        $this->post("{$this->base}/students/{$student['id']}/photo", ['photo' => $this->image(), 'request_id' => $requestId, 'photo_revision' => 2], ['Accept' => 'application/json'])->assertCreated()->assertJsonPath('photo_revision', 3);
        $this->post("{$this->base}/students/{$student['id']}/photo", ['photo' => $this->image(), 'request_id' => $requestId, 'photo_revision' => 2], ['Accept' => 'application/json'])->assertOk()->assertJsonPath('photo_revision', 3);
        $events = $this->getJson("{$this->base}/audit")->assertOk()->json('entries');
        $this->assertCount(2, array_filter($events, fn (array $entry): bool => $entry['event'] === 'student.photo_changed'));
        $this->assertStringNotContainsString('data:image', json_encode($events));
        $this->assertStringNotContainsString('student-photos/', json_encode($events));
    }

    public function test_existing_centers_keep_profile_identity_custom_history_and_requests_and_accept_the_size_boundary(): void
    {
        $requestId = (string) Str::uuid();
        $field = $this->postJson("{$this->base}/student-custom-fields", ['id' => (string) Str::uuid(), 'label' => 'بيان محفوظ', 'type' => 'text', 'required' => false, 'position' => 0, 'options' => []])->assertCreated()->json('field');
        $payload = ['name' => 'ملف سابق للصورة', 'branch_ids' => [$this->north], 'request_id' => $requestId, 'passport_number' => 'PRESERVED-BEFORE-PHOTO', 'custom_values' => [$field['id'] => 'PRESERVED-CUSTOM']];
        $student = $this->postJson("{$this->base}/students", $payload)->assertCreated()->json('student');
        $this->center->run(function (): void {
            $path = glob(database_path('migrations/tenant/*_add_student_photos.php'))[0];
            (require $path)->down();
            DB::table('migrations')->where('migration', pathinfo($path, PATHINFO_FILENAME))->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->postJson("{$this->base}/students", $payload)->assertOk()->assertJsonPath('student.id', $student['id'])->assertJsonPath('student.student_number', $student['student_number'])->assertJsonPath('student.identity.passport_number', 'PRESERVED-BEFORE-PHOTO')->assertJsonPath('student.photo', null)->assertJsonPath('student.photo_revision', 1);
        $this->getJson("{$this->base}/students/{$student['id']}?tab=custom-history")->assertOk()->assertJsonPath('custom_history.entries.0.value', 'PRESERVED-CUSTOM');
        $boundary = $this->image();
        file_put_contents($boundary->getRealPath(), str_repeat('x', 10 * 1024 * 1024 - filesize($boundary->getRealPath())), FILE_APPEND);
        clearstatcache(true, $boundary->getRealPath());
        $this->post("{$this->base}/students/{$student['id']}/photo", ['photo' => $boundary, 'request_id' => (string) Str::uuid(), 'photo_revision' => 1], ['Accept' => 'application/json'])->assertCreated();
        $read = $this->getJson("{$this->base}/students/{$student['id']}?tab=custom-history")->assertOk()->assertJsonPath('custom_history.entries.0.value', 'PRESERVED-CUSTOM')->assertJsonPath('students.0.custom_values.'.$field['id'], 'PRESERVED-CUSTOM');
        $this->assertNotNull($read->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $read->headers->get('X-Courses-Query-Count'));
    }

    private function image(): UploadedFile
    {
        $path = tempnam(sys_get_temp_dir(), 'courses-photo-');
        $image = imagecreatetruecolor(2, 2);
        imagefill($image, 0, 0, imagecolorallocate($image, 20, 100, 60));
        imagepng($image, $path);

        return new UploadedFile($path, 'student.png', 'image/png', null, true);
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
