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

class StudentSuspensionTest extends TestCase
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
        $this->actingAs($this->owner, 'web')->withSession(['center_id' => $this->center->id]);
        $this->north = $this->postJson("{$this->base}/branches", ['name' => 'North', 'slug' => 'north'])->assertCreated()->json('branch.id');
        $this->south = $this->postJson("{$this->base}/branches", ['name' => 'South', 'slug' => 'south'])->assertCreated()->json('branch.id');
    }

    public function test_owner_suspends_and_admin_lifts_with_a_persistent_period_and_idempotent_decisions(): void
    {
        $student = $this->postJson("{$this->base}/students", ['name' => 'Student', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $this->assertSame('active', $student['status']);
        $route = "{$this->base}/students/{$student['id']}/status";
        $decision = ['status' => 'suspended', 'reason' => 'سبب الإيقاف', 'status_revision' => 1, 'request_id' => (string) Str::uuid()];
        $this->postJson($route, $decision)->assertOk()->assertJsonPath('status', 'suspended')->assertJsonPath('status_revision', 2);
        $this->postJson($route, $decision)->assertOk();
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonCount(1, 'suspensions')
            ->assertJsonPath('suspensions.0.suspended_reason', 'سبب الإيقاف')->assertJsonPath('suspensions.0.suspended_by', $this->owner->id);
        $this->postJson($route, [...$decision, 'reason' => 'Different'])->assertConflict();
        $this->postJson($route, [...$decision, 'request_id' => (string) Str::uuid()])->assertConflict();
        $this->postJson($route, [...$decision, 'status' => 'active', 'request_id' => (string) Str::uuid()])->assertConflict();
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", ['center_roles' => ['center_admin'], 'branch_roles' => []])->assertOk();
        $this->actingAs($this->staff, 'web')->withSession(['center_id' => $this->center->id]);
        $lift = ['status' => 'active', 'reason' => 'سبب فك الإيقاف', 'status_revision' => 2, 'request_id' => (string) Str::uuid()];
        $this->postJson($route, $lift)->assertOk()->assertJsonPath('status_revision', 3);
        $this->postJson($route, $lift)->assertOk();
        $this->postJson($route, $decision)->assertForbidden();
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.status', 'active')
            ->assertJsonPath('suspensions.0.lifted_reason', 'سبب فك الإيقاف')->assertJsonPath('suspensions.0.lifted_by', $this->staff->id);
        $events = collect($this->getJson("{$this->base}/audit")->assertOk()->json('entries'))->whereIn('event', ['student.suspended', 'student.reactivated']);
        $this->assertCount(2, $events);
    }

    public function test_general_saves_preserve_status_and_operational_staff_cannot_change_it(): void
    {
        $student = $this->postJson("{$this->base}/students", ['name' => 'Student', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $route = "{$this->base}/students/{$student['id']}/status";
        $decision = ['status' => 'suspended', 'reason' => 'Reason', 'status_revision' => 1, 'request_id' => (string) Str::uuid()];
        $this->postJson($route, [...$decision, 'reason' => '   '])->assertUnprocessable();
        $this->postJson($route, [...$decision, 'status' => 'withdrawn'])->assertUnprocessable();
        $this->postJson($route, $decision)->assertOk();
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'Updated', 'branch_ids' => [], 'revision' => 1])->assertOk()
            ->assertJsonPath('student.status', 'suspended')->assertJsonPath('student.status_revision', 2)->assertJsonPath('student.student_number', $student['student_number']);
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'Updated', 'branch_ids' => [], 'revision' => 2, 'status' => 'active'])->assertUnprocessable();
        foreach (['registration', 'attendance', 'accounting', 'branch_manager', 'branch_viewer'] as $role) {
            $this->actingAs($this->owner, 'web')->withSession(['center_id' => $this->center->id]);
            $this->putJson("{$this->base}/members/{$this->membership->id}/grants", ['center_roles' => [], 'branch_roles' => [$this->north => [$role]]])->assertOk();
            $this->actingAs($this->staff, 'web')->withSession(['center_id' => $this->center->id]);
            $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonCount(1, 'suspensions')->assertJsonPath('students.0.can_change_status', false);
            $this->postJson($route, [...$decision, 'status' => 'active', 'status_revision' => 2])->assertForbidden();
        }
    }

    public function test_existing_profiles_migrate_as_active_and_history_reads_remain_bounded(): void
    {
        $student = $this->postJson("{$this->base}/students", ['name' => 'Legacy', 'phone' => '01012345678', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $this->center->run(function (): void {
            $migration = require database_path('migrations/tenant/2026_09_27_140230_add_student_suspension_history.php');
            $migration->down();
            DB::table('migrations')->where('migration', '2026_09_27_140230_add_student_suspension_history')->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $single = $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.status', 'active')
            ->assertJsonPath('students.0.student_number', $student['student_number'])->assertJsonPath('students.0.phone', '01012345678')->assertJsonPath('students.0.branch_ids', [$this->north]);
        for ($revision = 1; $revision <= 42; $revision++) {
            $this->postJson("{$this->base}/students/{$student['id']}/status", ['status' => $revision % 2 ? 'suspended' : 'active', 'reason' => "Decision {$revision}", 'status_revision' => $revision, 'request_id' => (string) Str::uuid()])->assertOk();
        }
        $many = $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonCount(20, 'suspensions')->assertJsonPath('status_pagination.has_more', true);
        $this->assertGreaterThan(0, (int) $many->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $many->headers->get('X-Courses-Query-Count'));
        $this->assertSame($single->headers->get('X-Courses-Query-Count'), $many->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$this->base}/students/{$student['id']}?status_page=2")->assertOk()->assertJsonCount(1, 'suspensions')->assertJsonPath('status_pagination.has_more', false);
    }
}
