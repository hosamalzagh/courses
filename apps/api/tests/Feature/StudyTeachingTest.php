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

class StudyTeachingTest extends TestCase
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

    public function test_actual_teaching_supports_substitutes_concurrent_and_sequential_segments_with_corrections(): void
    {
        [$group, $session, $assigned] = $this->createSession();
        $substitute = $this->instructor('Substitute', $this->north);
        $otherBranch = $this->instructor('South only', $this->south);
        $path = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/teaching";
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $this->travelTo(now()->addDays(2));

        $workspace = $this->getJson($path)->assertOk()->assertJsonPath('can_record', true)
            ->assertJsonPath('session.suggested_instructors.0.id', $assigned['id']);
        $this->assertLessThanOrEqual(6, (int) $workspace->headers->get('X-Courses-Query-Count'));
        $cancelPath = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}";
        $cancelPreview = $this->getJson("{$cancelPath}/cancel-preview")->assertOk()->json();
        $this->putJson($path, ['revision' => 1, 'request_id' => (string) Str::uuid(), 'segments' => [
            ['instructor_id' => $otherBranch['id'], 'start_minute' => 0, 'duration_minutes' => 60],
        ]])->assertUnprocessable();

        $segments = [
            ['instructor_id' => $assigned['id'], 'start_minute' => 0, 'duration_minutes' => 60],
            ['instructor_id' => $substitute['id'], 'start_minute' => 30, 'duration_minutes' => 60],
            ['instructor_id' => $assigned['id'], 'start_minute' => 60, 'duration_minutes' => 30],
        ];
        $requestId = (string) Str::uuid();
        $this->putJson($path, ['revision' => 1, 'request_id' => $requestId, 'segments' => $segments])
            ->assertCreated()->assertJsonPath('revision', 2)->assertJsonCount(3, 'segments');
        $this->getJson("{$cancelPath}/cancel-preview")->assertConflict()->assertJsonPath('code', 'session_has_teaching');
        $this->postJson("{$cancelPath}/cancel", [
            'reason' => 'إلغاء بعد التدريس', 'decision' => 'academic',
            'group_revision' => $cancelPreview['group_revision'],
            'session_revision' => $cancelPreview['session_revision'],
            'preview_token' => $cancelPreview['preview_token'],
            'request_id' => (string) Str::uuid(),
        ])->assertConflict()->assertJsonPath('code', 'session_has_teaching');
        $this->putJson($path, ['revision' => 1, 'request_id' => $requestId, 'segments' => $segments])
            ->assertOk()->assertJsonPath('replayed', true);
        $this->putJson($path, ['revision' => 1, 'request_id' => $requestId, 'segments' => array_slice($segments, 0, 1)])
            ->assertConflict()->assertJsonPath('code', 'teaching_request_changed');
        $this->putJson($path, ['revision' => 1, 'request_id' => (string) Str::uuid(), 'segments' => $segments])
            ->assertConflict()->assertJsonPath('code', 'teaching_changed');
        $this->putJson($path, ['revision' => 2, 'request_id' => (string) Str::uuid(), 'segments' => array_slice($segments, 0, 2)])
            ->assertUnprocessable();
        $this->putJson($path, ['revision' => 2, 'request_id' => (string) Str::uuid(), 'segments' => array_slice($segments, 0, 2),
            'reason' => 'تصحيح مدة المحاضر'])->assertCreated()->assertJsonPath('revision', 3);

        $this->center->run(function () use ($session): void {
            $this->assertSame(2, DB::table('study_session_teaching_segments')->where('session_id', $session['id'])->count());
            $this->assertSame(2, DB::table('center_audit_logs')->whereIn('event', [
                'study_session.teaching_recorded', 'study_session.teaching_corrected',
            ])->count());
            $this->assertSame(0, DB::table('study_attendance_entries')->where('session_id', $session['id'])->count());
            $audit = json_decode(DB::table('center_audit_logs')->where('event', 'study_session.teaching_corrected')
                ->latest('id')->value('details'), true);
            $this->assertSame('تصحيح مدة المحاضر', $audit['reason']);
            $this->assertSame('Substitute', $audit['after'][1]['instructor_name']);
        });
    }

    public function test_teaching_is_branch_scoped_and_denied_before_the_session_starts(): void
    {
        [$group, $session, $assigned] = $this->createSession();
        $path = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/teaching";
        $this->getJson($path)->assertOk()->assertJsonPath('can_record', false);
        $this->putJson($path, ['revision' => 1, 'request_id' => (string) Str::uuid(), 'segments' => [
            ['instructor_id' => $assigned['id'], 'start_minute' => 0, 'duration_minutes' => 60],
        ]])->assertForbidden();
        $this->grant([$this->south => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->getJson($path)->assertNotFound();
        $this->putJson($path, ['revision' => 1, 'request_id' => (string) Str::uuid(), 'segments' => []])->assertNotFound();
    }

    private function createSession(): array
    {
        $course = $this->postJson("{$this->base}/courses", [
            'branch_id' => $this->north, 'name' => 'Course', 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", [
            'name' => 'Stage', 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('stage');
        $level = $this->postJson("{$this->base}/stages/{$stage['id']}/levels", [
            'name' => 'Level', 'request_id' => (string) Str::uuid(),
            'lectures' => [['number' => 1, 'content' => 'Lecture 1', 'planned_hours' => 2]],
        ])->assertCreated()->json('level');
        $instructor = $this->instructor('Assigned', $this->north);
        $group = $this->postJson("{$this->base}/groups", [
            'level_id' => $level['id'], 'plan_version_id' => $level['plan']['id'], 'name' => 'Group',
            'approved_price' => '100.00', 'instructor_ids' => [$instructor['id']], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1,
            'start_at' => now('Africa/Cairo')->addDay()->setTime(16, 0)->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');

        return [$group, $session, $instructor];
    }

    private function instructor(string $name, int $branchId): array
    {
        return $this->postJson("{$this->base}/instructors", [
            'name' => $name, 'branch_ids' => [$branchId], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('instructor');
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
