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
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class StudentAttachmentTest extends TestCase
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
        $this->center->run(fn () => DB::table('center_grants')->insert(['user_id' => $this->owner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now()]));
        $this->asUser($this->owner);
        $this->north = $this->postJson("{$this->base}/branches", ['name' => 'North', 'slug' => 'north'])->assertCreated()->json('branch.id');
        $this->south = $this->postJson("{$this->base}/branches", ['name' => 'South', 'slug' => 'south'])->assertCreated()->json('branch.id');
    }

    public function test_batch_is_private_idempotent_and_within_read_budget(): void
    {
        $student = $this->student();
        $requestId = (string) Str::uuid();
        $payload = $this->payload($requestId, 1, [
            ['title' => 'صورة عامة', 'classification' => 'general', 'file' => $this->image()],
            ['title' => 'بطاقة هوية', 'classification' => 'identity', 'file' => $this->pdf()],
        ]);
        $result = $this->post("{$this->base}/students/{$student['id']}/attachments", $payload, ['Accept' => 'application/json'])->assertCreated();
        $general = $result->json('attachments.0');
        $identity = $result->json('attachments.1');
        $this->get('http://alpha.courses.test'.$general['preview_url'])->assertOk()->assertHeader('Content-Type', 'image/png')->assertHeader('X-Content-Type-Options', 'nosniff');
        $this->get('http://alpha.courses.test'.$identity['download_url'])->assertOk()->assertHeader('Content-Type', 'application/pdf')->assertHeader('Cache-Control', 'no-store, private');
        $this->post("{$this->base}/students/{$student['id']}/attachments", $payload, ['Accept' => 'application/json'])->assertOk()->assertJsonPath('attachments.0.id', $general['id']);
        $page = $this->getJson("{$this->base}/students/{$student['id']}?tab=attachments")->assertOk()->assertJsonCount(2, 'attachments.entries');
        $this->assertNotNull($page->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $page->headers->get('X-Courses-Query-Count'));
        $this->center->run(function () use ($student): void {
            $this->assertSame(2, DB::table('student_attachments')->where('student_id', $student['id'])->count());
            $audit = DB::table('center_audit_logs')->where('event', 'student.attachments_added')->first();
            $this->assertNotNull($audit);
            $this->assertSame(['student_id' => $student['id'], 'count' => 2], json_decode($audit->details, true));
        });
        $this->post("{$this->base}/students/{$student['id']}/attachments", $this->payload($requestId, 1, [['title' => 'مختلف', 'classification' => 'general', 'file' => $this->image()]]), ['Accept' => 'application/json'])->assertConflict();
        $this->post("{$this->base}/students/{$student['id']}/attachments", $this->payload((string) Str::uuid(), 1, [['title' => 'متأخر', 'classification' => 'general', 'file' => $this->image()]]), ['Accept' => 'application/json'])->assertConflict();
    }

    public function test_invalid_upload_and_failed_audit_leave_no_visible_attachment(): void
    {
        $student = $this->student();
        $oversized = $this->image();
        file_put_contents($oversized->getRealPath(), str_repeat('x', 10 * 1024 * 1024), FILE_APPEND);
        $forged = tempnam(sys_get_temp_dir(), 'courses-attachment-');
        file_put_contents($forged, '<script>not an image</script>');
        $partial = $this->image();
        foreach ([$oversized, new UploadedFile($forged, 'forged.png', 'image/png', null, true), new UploadedFile($partial->getRealPath(), 'partial.png', 'image/png', UPLOAD_ERR_PARTIAL, true)] as $file) {
            $this->post("{$this->base}/students/{$student['id']}/attachments", $this->payload((string) Str::uuid(), 1, [['title' => 'غير صالح', 'classification' => 'general', 'file' => $file]]), ['Accept' => 'application/json'])->assertUnprocessable()->assertJsonValidationErrors('attachments.0.file');
        }
        $this->post("{$this->base}/students/{$student['id']}/attachments", $this->payload((string) Str::uuid(), 1, [
            ['title' => 'صحيح', 'classification' => 'general', 'file' => $this->image()],
            ['title' => 'مزور', 'classification' => 'general', 'file' => new UploadedFile($forged, 'forged.png', 'image/png', null, true)],
        ]), ['Accept' => 'application/json'])->assertUnprocessable()->assertJsonValidationErrors('attachments.1.file');
        $requestId = (string) Str::uuid();
        $batch = [
            ['title' => 'صورة', 'classification' => 'general', 'file' => $this->image()],
            ['title' => 'صورة ثانية', 'classification' => 'general', 'file' => $this->image()],
        ];
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT attachment_acceptance_failure CHECK (event <> 'student.attachments_added') NOT VALID"));
        try {
            $this->post("{$this->base}/students/{$student['id']}/attachments", $this->payload($requestId, 1, $batch), ['Accept' => 'application/json'])->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT attachment_acceptance_failure'));
        }
        $this->getJson("{$this->base}/students/{$student['id']}?tab=attachments")->assertOk()->assertJsonCount(0, 'attachments.entries')->assertJsonPath('students.0.attachment_revision', 1);
        $this->assertSame([], Storage::disk('local')->allFiles('student-attachments/'.$this->center->id));
        $this->post("{$this->base}/students/{$student['id']}/attachments", $this->payload($requestId, 1, $batch), ['Accept' => 'application/json'])->assertCreated()->assertJsonCount(2, 'attachments');
    }

    public function test_current_identity_branch_and_membership_grants_control_every_link(): void
    {
        $student = $this->student();
        $result = $this->post("{$this->base}/students/{$student['id']}/attachments", $this->payload((string) Str::uuid(), 1, [
            ['title' => 'عام', 'classification' => 'general', 'file' => $this->image()],
            ['title' => 'هوية', 'classification' => 'identity', 'file' => $this->pdf()],
        ]), ['Accept' => 'application/json'])->assertCreated();
        $general = $result->json('attachments.0');
        $identity = $result->json('attachments.1');
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/students/{$student['id']}?tab=attachments")->assertOk()->assertJsonCount(1, 'attachments.entries');
        $this->get('http://alpha.courses.test'.$general['preview_url'])->assertOk();
        $this->get('http://alpha.courses.test'.$identity['preview_url'])->assertNotFound();
        $this->post("{$this->base}/students/{$student['id']}/attachments", $this->payload((string) Str::uuid(), 2, [['title' => 'هوية', 'classification' => 'identity', 'file' => $this->pdf()]]), ['Accept' => 'application/json'])->assertForbidden();
        $this->grant([$this->north => ['registration', 'student_identity']]);
        $this->asUser($this->staff);
        $this->get('http://alpha.courses.test'.$identity['download_url'])->assertOk();
        $this->grant([$this->south => ['registration', 'student_identity']]);
        $this->asUser($this->staff);
        $this->get('http://alpha.courses.test'.$identity['download_url'])->assertNotFound();
        $this->get('http://alpha.courses.test'.$general['download_url'])->assertNotFound();
        $this->grant([$this->north => ['registration', 'student_identity']]);
        $this->membership->update(['status' => 'suspended']);
        $this->asUser($this->staff);
        $this->get('http://alpha.courses.test'.$identity['download_url'])->assertForbidden();
    }

    public function test_existing_center_migration_preserves_student_and_request(): void
    {
        $student = $this->student();
        $this->center->run(function (): void {
            $path = glob(database_path('migrations/tenant/*_create_student_attachments.php'))[0];
            (require $path)->down();
            DB::table('migrations')->where('migration', pathinfo($path, PATHINFO_FILENAME))->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.student_number', $student['student_number'])->assertJsonPath('students.0.attachment_revision', 1);
    }

    public function test_attachment_pages_stay_bounded_with_a_longer_list(): void
    {
        $student = $this->student();
        foreach (range(1, 5) as $batch) {
            $items = [];
            foreach (range(1, 5) as $position) {
                $items[] = ['title' => "ملف {$batch}-{$position}", 'classification' => 'general', 'file' => $this->image()];
            }
            $this->post("{$this->base}/students/{$student['id']}/attachments", $this->payload((string) Str::uuid(), $batch, $items), ['Accept' => 'application/json'])->assertCreated();
        }
        foreach ([1 => [20, true], 2 => [5, false]] as $number => [$count, $more]) {
            $page = $this->getJson("{$this->base}/students/{$student['id']}?tab=attachments&attachments_page={$number}")->assertOk()
                ->assertJsonCount($count, 'attachments.entries')->assertJsonPath('attachments.pagination.has_more', $more);
            $this->assertNotNull($page->headers->get('X-Courses-Query-Count'));
            $this->assertLessThanOrEqual(6, (int) $page->headers->get('X-Courses-Query-Count'));
        }
    }

    private function student(): array
    {
        return $this->postJson("{$this->base}/students", ['name' => 'طالب مرفقات', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
    }

    private function payload(string $requestId, int $revision, array $items): array
    {
        return ['request_id' => $requestId, 'attachment_revision' => $revision, 'attachments' => $items];
    }

    private function image(): UploadedFile
    {
        $path = tempnam(sys_get_temp_dir(), 'courses-attachment-');
        $image = imagecreatetruecolor(2, 2);
        imagefill($image, 0, 0, imagecolorallocate($image, 20, 100, 60));
        imagepng($image, $path);

        return new UploadedFile($path, 'student.png', 'image/png', null, true);
    }

    private function pdf(): UploadedFile
    {
        $path = tempnam(sys_get_temp_dir(), 'courses-attachment-');
        file_put_contents($path, "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");

        return new UploadedFile($path, 'student.pdf', 'application/pdf', null, true);
    }

    private function grant(array $roles): void
    {
        $this->asUser($this->owner);
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", ['center_roles' => [], 'branch_roles' => $roles])->assertOk();
    }

    private function asUser(User $user): void
    {
        $this->actingAs($user, 'web')->withSession(['center_id' => $this->center->id]);
    }
}
