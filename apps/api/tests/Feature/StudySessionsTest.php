<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class StudySessionsTest extends TestCase
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

    public function test_preview_generation_retry_and_postponement_preserve_whole_requirements_and_history(): void
    {
        $group = $this->group($this->north, 'Schedule');
        $path = "{$this->base}/groups/{$group['id']}/sessions";
        $start = now('Africa/Cairo')->addDays(14)->setTime(16, 0)->format('Y-m-d\TH:i');
        $payload = ['kind' => 'weekly', 'revision' => 1, 'start_at' => $start, 'count' => 2, 'interval_weeks' => 1];
        $preview = $this->postJson("{$path}/preview", $payload)->assertOk()->assertJsonCount(2, 'sessions')
            ->assertJsonPath('sessions.0.plan_lecture_number', 1)->assertJsonPath('sessions.1.plan_lecture_number', 2)
            ->json('sessions');
        $requestId = (string) Str::uuid();
        $saved = $this->postJson($path, [...$payload, 'request_id' => $requestId])->assertCreated()
            ->assertJsonCount(2, 'sessions')->assertJsonPath('group_revision', 2)->json('sessions');
        $this->assertSame(strtotime($preview[0]['scheduled_at']), strtotime($saved[0]['scheduled_at']));
        $this->postJson($path, [...$payload, 'request_id' => $requestId])->assertOk()->assertJsonCount(2, 'sessions');
        $this->postJson($path, [...$payload, 'count' => 1, 'request_id' => $requestId])
            ->assertConflict()->assertJsonPath('code', 'session_request_changed');
        $this->postJson($path, [...$payload, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'group_changed');
        $workspace = $this->getJson($path)->assertOk()->assertJsonCount(2, 'sessions')
            ->assertJsonPath('group.requirements.2.number', 3);
        $this->assertNotNull($workspace->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $workspace->headers->get('X-Courses-Query-Count'));
        $single = ['kind' => 'single', 'revision' => 2,
            'start_at' => now('Africa/Cairo')->addDays(17)->setTime(17, 0)->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 3, 'title' => 'مراجعة ختامية'];
        $this->postJson($path, [...$single, 'request_id' => (string) Str::uuid()])
            ->assertCreated()->assertJsonPath('sessions.0.plan_lecture_number', 3)
            ->assertJsonPath('sessions.0.title', 'مراجعة ختامية');
        $this->postJson("{$path}/preview", [...$single, 'revision' => 3])->assertUnprocessable();
        $this->center->run(fn () => $this->assertSame(3, DB::table('study_sessions')->count()));

        $newTime = now('Africa/Cairo')->addDays(24)->setTime(16, 0)->format('Y-m-d\TH:i');
        $move = ['revision' => 1, 'scheduled_at' => $newTime, 'reason' => 'إجازة', 'request_id' => (string) Str::uuid()];
        $moved = $this->patchJson("{$path}/{$saved[0]['id']}/postpone", $move)->assertOk()
            ->assertJsonPath('session.revision', 2)->json('session');
        $this->assertNotSame($saved[0]['scheduled_at'], $moved['scheduled_at']);
        $this->patchJson("{$path}/{$saved[0]['id']}/postpone", $move)->assertOk()->assertJsonPath('session.revision', 2);
        $this->patchJson("{$path}/{$saved[0]['id']}/postpone", [...$move, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'session_changed');
        $this->center->run(function () use ($saved): void {
            $this->assertSame(3, DB::table('study_sessions')->count());
            $this->assertSame(1, DB::table('center_audit_logs')->where('event', 'study_session.postponed')->count());
            $this->assertSame(1, DB::table('study_sessions')->where('id', $saved[0]['id'])->where('revision', 2)->count());
        });
    }

    public function test_branch_grants_and_held_sessions_prevent_cross_branch_changes(): void
    {
        $visible = $this->group($this->north, 'Visible');
        $hidden = $this->group($this->south, 'Hidden');
        $path = "{$this->base}/groups/{$visible['id']}/sessions";
        $hiddenPath = "{$this->base}/groups/{$hidden['id']}/sessions";
        $start = now('Africa/Cairo')->addDays(14)->setTime(16, 0)->format('Y-m-d\TH:i');
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->getJson($path)->assertOk();
        $this->getJson($hiddenPath)->assertNotFound();
        $this->postJson("{$path}/preview", ['kind' => 'single', 'revision' => 1, 'start_at' => $start,
            'plan_lecture_number' => 1])->assertForbidden();
        $this->grant([$this->north => ['academic_admin']]);
        $this->asUser($this->staff);
        $this->postJson($hiddenPath, ['kind' => 'single', 'revision' => 1, 'start_at' => $start,
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid()])->assertNotFound();
        $created = $this->postJson($path, ['kind' => 'single', 'revision' => 1, 'start_at' => $start,
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid()])->assertCreated()->json('sessions.0');
        $this->center->run(fn () => DB::table('study_sessions')->where('id', $created['id'])->update(['status' => 'held']));
        $this->patchJson("{$path}/{$created['id']}/postpone", [
            'revision' => 1, 'scheduled_at' => now('Africa/Cairo')->addDays(20)->format('Y-m-d\TH:i'),
            'request_id' => (string) Str::uuid(),
        ])->assertConflict()->assertJsonPath('code', 'session_changed');
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->postJson($path, ['kind' => 'single', 'revision' => 2, 'start_at' => $start,
            'plan_lecture_number' => 2, 'request_id' => (string) Str::uuid()])->assertForbidden();
    }

    private function group(int $branchId, string $name): array
    {
        $course = $this->postJson("{$this->base}/courses", [
            'branch_id' => $branchId, 'name' => $name, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", [
            'name' => 'Stage', 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('stage');
        $level = $this->postJson("{$this->base}/stages/{$stage['id']}/levels", [
            'name' => 'Level', 'request_id' => (string) Str::uuid(),
            'lectures' => [
                ['number' => 1, 'content' => 'First', 'planned_hours' => 1],
                ['number' => 2, 'content' => 'Second', 'planned_hours' => 1],
                ['number' => 3, 'content' => 'Third', 'planned_hours' => 1],
            ],
        ])->assertCreated()->json('level');
        $instructor = $this->postJson("{$this->base}/instructors", [
            'name' => "Teacher {$name}", 'branch_ids' => [$branchId], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('instructor');

        return $this->postJson("{$this->base}/groups", [
            'level_id' => $level['id'], 'plan_version_id' => $level['plan']['id'], 'name' => "Group {$name}",
            'approved_price' => '100.00', 'instructor_ids' => [$instructor['id']],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
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
