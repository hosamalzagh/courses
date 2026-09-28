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
        $this->postJson($path, [...$payload, 'request_id' => $requestId])->assertOk()->assertJsonCount(2, 'sessions')
            ->assertJsonPath('group_revision', 2);
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
        $this->patchJson("{$path}/{$saved[0]['id']}/postpone", $move)->assertOk()->assertJsonPath('session.revision', 2)
            ->assertJsonPath('group_revision', 4);
        $this->patchJson("{$path}/{$saved[0]['id']}/postpone", [...$move, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'session_changed');
        $this->center->run(function () use ($saved): void {
            $this->assertSame(3, DB::table('study_sessions')->count());
            $this->assertSame(1, DB::table('center_audit_logs')->where('event', 'study_session.postponed')->count());
            $this->assertSame(1, DB::table('study_sessions')->where('id', $saved[0]['id'])->where('revision', 2)->count());
        });
    }

    public function test_scheduled_requirement_summary_remains_complete_after_session_pagination(): void
    {
        $group = $this->group($this->north, 'Paged', 22);
        $path = "{$this->base}/groups/{$group['id']}/sessions";
        $start = now('Africa/Cairo')->addDays(14)->setTime(16, 0)->format('Y-m-d\TH:i');
        $this->postJson($path, ['kind' => 'weekly', 'revision' => 1, 'start_at' => $start,
            'count' => 20, 'interval_weeks' => 1, 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->postJson($path, ['kind' => 'single', 'revision' => 2,
            'start_at' => now('Africa/Cairo')->addDays(160)->setTime(17, 0)->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 21, 'request_id' => (string) Str::uuid()])->assertCreated();
        $page = $this->getJson("{$path}?page=2")->assertOk()->assertJsonCount(1, 'sessions')
            ->assertJsonCount(21, 'group.scheduled_requirements')->assertJsonPath('group.scheduled_requirements.0', 1)
            ->assertJsonPath('group.scheduled_requirements.20', 21)->assertJsonPath('group.requirements.21.number', 22);
        $this->assertLessThanOrEqual(6, (int) $page->headers->get('X-Courses-Query-Count'));
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

    public function test_attendance_stays_unrecorded_until_close_and_only_eligible_students_become_absent(): void
    {
        $group = $this->group($this->north, 'Attendance');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $path = "{$this->base}/groups/{$group['id']}/sessions";
        $session = $this->postJson($path, [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $group['revision'] = 2;
        $attendance = "{$path}/{$session['id']}/attendance";
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $first = $this->student();
        $second = $this->student();
        $late = $this->student();
        $left = $this->student();
        $this->enroll($first['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->enroll($second['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->enroll($late['id'], $group, $scheduled->copy()->addDay()->format('Y-m-d'));
        $this->enroll($left['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->center->run(fn () => DB::table('study_attempt_group_periods')
            ->where('attempt_id', DB::table('study_attempts')->where('student_id', $left['id'])->value('id'))
            ->update(['left_on' => $scheduled->format('Y-m-d')]));

        $before = $this->getJson($attendance)->assertOk()->assertJsonCount(2, 'students')
            ->assertJsonPath('students.0.status', null);
        $this->assertLessThanOrEqual(6, (int) $before->headers->get('X-Courses-Query-Count'));
        $firstAttempt = collect($before->json('students'))->firstWhere('student_id', $first['id'])['attempt_id'];
        $this->postJson($attendance, ['attempt_id' => $firstAttempt, 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertConflict();

        $this->travelTo($scheduled->copy()->addHour());
        $this->postJson("{$this->base}/students/{$first['id']}/status", [
            'status' => 'suspended', 'reason' => 'إيقاف بعد انتهاء المحاضرة',
            'status_revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $requestId = (string) Str::uuid();
        $payload = ['attempt_id' => $firstAttempt, 'status' => 'counted', 'revision' => 1, 'request_id' => $requestId];
        $recorded = $this->postJson($attendance, $payload)->assertCreated()->assertJsonPath('revision', 2)->json('entry');
        $this->postJson($attendance, $payload)->assertOk()->assertJsonPath('entry.id', $recorded['id']);
        $this->grant([$this->north => ['attendance']]);
        $this->asUser($this->staff);
        $this->postJson("{$attendance}/{$recorded['id']}/undo", ['revision' => 2, 'request_id' => (string) Str::uuid()])
            ->assertConflict();
        $this->asUser($this->owner);
        $this->postJson($attendance, [...$payload, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'session_changed');
        $this->postJson("{$attendance}/{$recorded['id']}/undo", ['revision' => 2, 'request_id' => (string) Str::uuid()])
            ->assertOk()->assertJsonPath('entry.status', null)->assertJsonPath('revision', 3);
        $this->postJson($attendance, [...$payload, 'revision' => 3, 'request_id' => (string) Str::uuid()])
            ->assertCreated()->assertJsonPath('revision', 4);
        $this->postJson("{$path}/{$session['id']}/close", ['revision' => 4, 'request_id' => (string) Str::uuid()])
            ->assertOk()->assertJsonPath('absent_count', 1)->assertJsonPath('session.status', 'held');
        $after = $this->getJson($attendance)->assertOk()->assertJsonCount(2, 'students')->json('students');
        $this->assertSame('counted', collect($after)->firstWhere('student_id', $first['id'])['status']);
        $this->assertSame('absent', collect($after)->firstWhere('student_id', $second['id'])['status']);
        $this->postJson("{$attendance}/{$recorded['id']}/undo", ['revision' => 5, 'request_id' => (string) Str::uuid()])
            ->assertConflict();
        $this->center->run(function (): void {
            $this->assertSame(2, DB::table('study_attendance_entries')->whereNotNull('status')->count());
            $this->assertSame(4, DB::table('study_attendance_events')->count());
            $this->assertSame(4, DB::table('center_audit_logs')->where('event', 'like', 'study_attendance.%')->count());
        });
    }

    public function test_attendance_search_covers_later_server_pages_without_unbounded_rows(): void
    {
        $group = $this->group($this->north, 'Roster search');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $group['revision'] = 2;
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $last = null;
        for ($index = 0; $index < 21; $index++) {
            $last = $this->student();
            $this->enroll($last['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        }
        $path = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/attendance";
        $firstPage = $this->getJson($path)->assertOk()->assertJsonCount(20, 'students')
            ->assertJsonPath('pagination.has_more', true);
        $this->assertLessThanOrEqual(6, (int) $firstPage->headers->get('X-Courses-Query-Count'));
        $this->assertNotContains($last['id'], collect($firstPage->json('students'))->pluck('student_id'));
        $secondPage = $this->getJson("{$path}?page=2")->assertOk()->assertJsonCount(1, 'students')
            ->assertJsonPath('students.0.student_id', $last['id']);
        $this->assertLessThanOrEqual(6, (int) $secondPage->headers->get('X-Courses-Query-Count'));
        $matching = $this->getJson("{$path}?q=".rawurlencode($last['name']))->assertOk()
            ->assertJsonCount(1, 'students')->assertJsonPath('students.0.student_id', $last['id']);
        $this->assertLessThanOrEqual(6, (int) $matching->headers->get('X-Courses-Query-Count'));
        $this->travelTo($scheduled->copy()->addHour());
        $recorded = $this->postJson($path, ['attempt_id' => $firstPage->json('students.0.attempt_id'),
            'status' => 'counted', 'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated()->json('entry');
        $this->postJson("{$path}/{$recorded['id']}/undo", ['revision' => 2, 'request_id' => (string) Str::uuid()])->assertOk();
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/close", [
            'revision' => 3, 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('absent_count', 21);
        $this->center->run(function () use ($recorded): void {
            $this->assertSame(21, DB::table('study_attendance_entries')->where('status', 'absent')->count());
            $this->assertSame(3, DB::table('study_attendance_entries')->where('id', $recorded['id'])->value('revision'));
        });
    }

    public function test_cancelled_session_cannot_record_or_close_attendance(): void
    {
        $group = $this->group($this->north, 'Cancelled attendance');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->center->run(fn () => DB::table('study_sessions')->where('id', $session['id'])->update(['status' => 'cancelled']));
        $this->travelTo($scheduled->copy()->addHour());
        $path = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}";
        $this->postJson("{$path}/attendance", ['attempt_id' => (string) Str::uuid(), 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertConflict();
        $this->postJson("{$path}/close", ['revision' => 1, 'request_id' => (string) Str::uuid()])->assertConflict();
        $this->center->run(fn () => $this->assertSame(0, DB::table('study_attendance_entries')->count()));
    }

    public function test_attendance_permission_and_hidden_branch_are_enforced(): void
    {
        $visible = $this->group($this->north, 'Visible attendance');
        $hidden = $this->group($this->south, 'Hidden attendance');
        $start = now('Africa/Cairo')->addDays(14)->setTime(16, 0)->format('Y-m-d\TH:i');
        $visibleSession = $this->postJson("{$this->base}/groups/{$visible['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $start,
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $hiddenSession = $this->postJson("{$this->base}/groups/{$hidden['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $start,
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $visiblePath = "{$this->base}/groups/{$visible['id']}/sessions/{$visibleSession['id']}/attendance";
        $hiddenPath = "{$this->base}/groups/{$hidden['id']}/sessions/{$hiddenSession['id']}/attendance";
        $this->getJson($visiblePath)->assertOk()->assertJsonPath('can_record', false);
        $this->getJson($hiddenPath)->assertNotFound();
        $this->travelTo(now()->addDays(15));
        $this->postJson($visiblePath, ['attempt_id' => (string) Str::uuid(), 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertForbidden();
        $this->postJson("{$this->base}/groups/{$visible['id']}/sessions/{$visibleSession['id']}/close", [
            'revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertForbidden();
        $this->postJson($hiddenPath, ['attempt_id' => (string) Str::uuid(), 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertNotFound();
    }

    private function group(int $branchId, string $name, int $lectureCount = 3): array
    {
        $course = $this->postJson("{$this->base}/courses", [
            'branch_id' => $branchId, 'name' => $name, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", [
            'name' => 'Stage', 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('stage');
        $level = $this->postJson("{$this->base}/stages/{$stage['id']}/levels", [
            'name' => 'Level', 'request_id' => (string) Str::uuid(),
            'lectures' => array_map(fn ($number) => ['number' => $number, 'content' => "Lecture {$number}", 'planned_hours' => 1], range(1, $lectureCount)),
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

    private function student(): array
    {
        return $this->postJson("{$this->base}/students", [
            'name' => 'Student '.Str::random(8), 'branch_ids' => [$this->north],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('student');
    }

    private function enroll(string $studentId, array $group, string $joinedOn): void
    {
        $url = "{$this->base}/students/{$studentId}/enrollments";
        $workspace = $this->getJson($url)->assertOk()->json();
        $this->postJson($url, [
            'group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $workspace['student']['currency_revision'],
            'joined_on' => $joinedOn, 'discount' => '0.00', 'discount_reason' => null,
            'version' => $workspace['student']['version'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
    }

    private function asUser(User $user): void
    {
        $this->actingAs($user, 'web')->withSession(['center_id' => $this->center->id]);
    }
}
