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
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $group['revision'] = 3;

        $this->travelTo($scheduled->copy()->addHour());
        $this->postJson("{$this->base}/students/{$first['id']}/status", [
            'status' => 'suspended', 'reason' => 'إيقاف بعد انتهاء المحاضرة',
            'status_revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $requestId = (string) Str::uuid();
        $payload = ['attempt_id' => $firstAttempt, 'status' => 'counted', 'revision' => 1, 'request_id' => $requestId];
        $this->postJson($attendance, $payload)->assertConflict()->assertJsonPath('code', 'student_suspended_for_session');
        $this->postJson("{$this->base}/students/{$first['id']}/status", [
            'status' => 'active', 'reason' => 'فك الإيقاف قبل تسجيل حضور سابق',
            'status_revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $recorded = $this->postJson($attendance, $payload)->assertCreated()->assertJsonPath('revision', 2)->json('entry');
        $this->postJson($attendance, $payload)->assertOk()->assertJsonPath('entry.id', $recorded['id']);
        $this->grant([$this->north => ['attendance']]);
        $this->asUser($this->staff);
        $this->postJson("{$attendance}/{$recorded['id']}/undo", ['revision' => 2, 'request_id' => (string) Str::uuid()])
            ->assertConflict();
        $this->asUser($this->owner);
        $this->postJson($attendance, [...$payload, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'session_changed');
        $undoRequestId = (string) Str::uuid();
        $this->postJson("{$attendance}/{$recorded['id']}/undo", ['revision' => 2, 'request_id' => $undoRequestId])
            ->assertOk()->assertJsonPath('entry.status', null)->assertJsonPath('revision', 3);
        $this->postJson($attendance, $payload)->assertOk()->assertJsonPath('revision', 2)
            ->assertJsonPath('entry.status', 'counted')->assertJsonPath('entry.revision', 1);
        $this->postJson($attendance, [...$payload, 'revision' => 3, 'request_id' => (string) Str::uuid()])
            ->assertCreated()->assertJsonPath('revision', 4);
        $this->postJson("{$attendance}/{$recorded['id']}/undo", ['revision' => 2, 'request_id' => $undoRequestId])
            ->assertOk()->assertJsonPath('revision', 3)
            ->assertJsonPath('entry.status', null)->assertJsonPath('entry.revision', 2);
        $this->postJson("{$path}/{$session['id']}/close", ['revision' => 4, 'request_id' => (string) Str::uuid()])
            ->assertOk()->assertJsonPath('absent_count', 1)->assertJsonPath('session.status', 'held');
        $after = $this->getJson($attendance)->assertOk()->assertJsonCount(2, 'students')->json('students');
        $this->assertSame('counted', collect($after)->firstWhere('student_id', $first['id'])['status']);
        $this->assertSame('absent', collect($after)->firstWhere('student_id', $second['id'])['status']);
        $this->center->run(fn () => DB::table('study_attempt_group_periods')->where('attempt_id', $firstAttempt)
            ->update(['left_on' => $scheduled->format('Y-m-d')]));
        $historicalRoster = $this->getJson($attendance)->assertOk()->assertJsonCount(2, 'students')->json('students');
        $this->assertSame('counted', collect($historicalRoster)->firstWhere('student_id', $first['id'])['status']);
        $backdated = $this->student();
        $this->enroll($backdated['id'], $group, now('Africa/Cairo')->subDay()->format('Y-m-d'));
        $closedRoster = $this->getJson($attendance)->assertOk()->assertJsonCount(2, 'students')->json('students');
        $this->assertNull(collect($closedRoster)->firstWhere('student_id', $backdated['id']));
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
        $this->center->run(fn () => DB::table('students')->where('id', $last['id'])->update(['student_number' => 1000]));
        $last['student_number'] = 1000;
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
        $arabicNumber = strtr((string) $last['student_number'], array_combine(str_split('0123456789'), mb_str_split('٠١٢٣٤٥٦٧٨٩')));
        $byNumber = $this->getJson("{$path}?q=".rawurlencode($arabicNumber))->assertOk()
            ->assertJsonCount(1, 'students')->assertJsonPath('students.0.student_id', $last['id']);
        $this->assertLessThanOrEqual(6, (int) $byNumber->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$path}?q=".rawurlencode('١٬٠٠٠'))->assertOk()
            ->assertJsonCount(1, 'students')->assertJsonPath('students.0.student_id', $last['id']);
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
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
            $details = json_decode(DB::table('center_audit_logs')->where('event', 'study_attendance.closed')->value('details'), true);
            $this->assertSame(21, $details['absent_count']);
            $this->assertCount(20, $details['absent_attempt_ids']);
        });
    }

    public function test_suspension_period_excludes_only_covered_sessions_and_lifting_preserves_history(): void
    {
        $group = $this->group($this->north, 'Suspension attendance');
        $firstAt = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $sessions = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'weekly', 'revision' => 1, 'start_at' => $firstAt->format('Y-m-d\TH:i'),
            'count' => 2, 'interval_weeks' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions');
        $group['revision'] = 2;
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $student = $this->student();
        $other = $this->student();
        $this->enroll($student['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->enroll($other['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $first = "{$this->base}/groups/{$group['id']}/sessions/{$sessions[0]['id']}/attendance";
        $second = "{$this->base}/groups/{$group['id']}/sessions/{$sessions[1]['id']}/attendance";
        $attempt = collect($this->getJson($first)->assertOk()->json('students'))->firstWhere('student_id', $student['id'])['attempt_id'];
        $this->travelTo($firstAt->copy()->addHour());
        $this->postJson($first, ['attempt_id' => $attempt, 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$sessions[0]['id']}/close", [
            'revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('absent_count', 1);
        $stale = $this->getJson($second)->assertOk()->json();
        $this->assertNull(collect($stale['students'])->firstWhere('student_id', $student['id'])['suspended_at']);
        $late = $this->student();
        $this->postJson("{$this->base}/students/{$student['id']}/status", [
            'status' => 'suspended', 'reason' => 'إيقاف بين المحاضرتين',
            'status_revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->postJson("{$this->base}/students/{$late['id']}/status", [
            'status' => 'suspended', 'reason' => 'إيقاف قبل الانضمام المتأخر',
            'status_revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->travelTo($firstAt->copy()->addWeek()->addHour());
        $requestId = (string) Str::uuid();
        $payload = ['attempt_id' => $attempt, 'status' => 'counted', 'revision' => $stale['session']['revision'], 'request_id' => $requestId];
        $this->postJson($second, $payload)->assertConflict()->assertJsonPath('code', 'student_suspended_for_session');
        $this->postJson($second, $payload)->assertConflict()->assertJsonPath('code', 'student_suspended_for_session');
        $covered = $this->getJson($second)->assertOk()->assertJsonCount(2, 'students');
        $this->assertLessThanOrEqual(6, (int) $covered->headers->get('X-Courses-Query-Count'));
        $row = collect($covered->json('students'))->firstWhere('student_id', $student['id']);
        $this->assertNotNull($row['suspended_at']);
        $this->assertNull($row['status']);
        $closeRequestId = (string) Str::uuid();
        $closePayload = ['revision' => 1, 'request_id' => $closeRequestId];
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$sessions[1]['id']}/close", $closePayload)
            ->assertOk()->assertJsonPath('absent_count', 1);
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$sessions[1]['id']}/close", $closePayload)
            ->assertOk()->assertJsonPath('absent_count', 1);
        $this->postJson("{$this->base}/students/{$student['id']}/status", [
            'status' => 'active', 'reason' => 'انتهاء الإيقاف',
            'status_revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->postJson("{$this->base}/students/{$late['id']}/status", [
            'status' => 'active', 'reason' => 'الالتحاق لاحقًا',
            'status_revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $group['revision'] = 3;
        $this->enroll($late['id'], $group, now('Africa/Cairo')->subWeeks(3)->format('Y-m-d'));
        $afterLift = collect($this->getJson($second)->assertOk()->json('students'))->firstWhere('student_id', $student['id']);
        $this->assertNotNull($afterLift['suspended_at']);
        $this->assertNotNull($afterLift['lifted_at']);
        $this->assertNull($afterLift['status']);
        $this->assertSame('counted', collect($this->getJson($first)->assertOk()->json('students'))
            ->firstWhere('student_id', $student['id'])['status']);
        $this->center->run(function () use ($sessions, $attempt): void {
            $this->assertSame(1, DB::table('study_attendance_entries')->where('session_id', $sessions[1]['id'])
                ->where('attempt_id', $attempt)->whereNull('status')->whereNull('recorded_by')->count());
            $this->assertSame(1, DB::table('study_attendance_entries')->where('session_id', $sessions[1]['id'])
                ->where('status', 'absent')->count());
            $this->assertSame(1, DB::table('center_audit_logs')->where('event', 'study_attendance.closed')
                ->where('details->session_id', $sessions[1]['id'])->count());
            $details = json_decode(DB::table('center_audit_logs')->where('event', 'study_attendance.closed')
                ->where('details->session_id', $sessions[1]['id'])->value('details'), true);
            $this->assertSame(1, $details['suspended_count']);
        });
        $migration = require database_path('migrations/tenant/2026_09_28_180003_backfill_suspended_closed_attendance.php');
        $this->center->run(function () use ($migration, $sessions, $attempt): void {
            DB::table('study_attendance_entries')->where('session_id', $sessions[1]['id'])
                ->where('attempt_id', $attempt)->delete();
            $closureAudit = DB::table('center_audit_logs')->where('event', 'study_attendance.closed')
                ->where('details->session_id', $sessions[1]['id']);
            $legacyDetails = json_decode($closureAudit->value('details'), true);
            unset($legacyDetails['suspended_count']);
            $closureAudit->update(['details' => json_encode($legacyDetails)]);
            $migration->up();
            $this->assertSame(1, DB::table('study_attendance_entries')->where('session_id', $sessions[1]['id'])
                ->where('attempt_id', $attempt)->whereNull('status')->count());
            $this->assertSame(2, DB::table('study_attendance_entries')->where('session_id', $sessions[1]['id'])->count());
            $backfillAudit = DB::table('center_audit_logs')->where('event', 'study_attendance.suspension_backfilled')
                ->where('details->session_id', $sessions[1]['id']);
            $this->assertSame(1, $backfillAudit->count());
            $this->assertSame(1, json_decode($backfillAudit->value('details'), true)['suspended_count']);
            $originalDetails = DB::table('center_audit_logs')->where('event', 'study_attendance.closed')
                ->where('details->session_id', $sessions[1]['id'])->value('details');
            $this->assertArrayNotHasKey('suspended_count', json_decode($originalDetails, true));
            $migration->up();
            $this->assertSame(1, $backfillAudit->count());
        });
        $this->getJson($second)->assertOk()->assertJsonCount(2, 'students');
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

    public function test_waiting_group_and_group_started_after_session_cannot_accept_attendance(): void
    {
        $group = $this->group($this->north, 'Waiting attendance');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $path = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}";
        $this->travelTo($scheduled->copy()->addHour());
        $this->getJson("{$path}/attendance")->assertOk()->assertJsonPath('has_started', false);
        $this->postJson("{$path}/attendance", ['attempt_id' => (string) Str::uuid(), 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertConflict()->assertJsonPath('code', 'session_changed');
        $this->postJson("{$path}/close", ['revision' => 1, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'session_changed');
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $this->getJson("{$path}/attendance")->assertOk()->assertJsonPath('has_started', false);
        $this->postJson("{$path}/close", ['revision' => 1, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'session_changed');
        $this->center->run(fn () => $this->assertSame(0, DB::table('study_attendance_entries')->count()));
    }

    public function test_attendance_and_absence_notes_keep_versions_and_follow_event_permission(): void
    {
        $group = $this->group($this->north, 'Notes');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $group['revision'] = 2;
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $present = $this->student();
        $absent = $this->student();
        $this->enroll($present['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->enroll($absent['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $this->travelTo($scheduled->copy()->addHour());
        $attendance = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/attendance";
        $rows = $this->getJson($attendance)->assertOk()->json('students');
        $attemptId = collect($rows)->firstWhere('student_id', $present['id'])['attempt_id'];
        $entry = $this->postJson($attendance, ['attempt_id' => $attemptId, 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated()->json('entry');
        $noteUrl = "{$attendance}/{$entry['id']}/note";
        $request = ['body' => 'حضر بعد التواصل', 'important' => false, 'revision' => 0,
            'entry_revision' => $entry['revision'],
            'request_id' => (string) Str::uuid()];
        $note = $this->putJson($noteUrl, $request)->assertCreated()->json('note');
        $this->putJson($noteUrl, $request)->assertOk()->assertJsonPath('note.id', $note['id']);
        $this->putJson($noteUrl, [...$request, 'body' => 'تبديل الطلب'])->assertConflict()
            ->assertJsonPath('code', 'note_request_changed');
        $this->putJson($noteUrl, [...$request, 'request_id' => (string) Str::uuid()])->assertConflict()
            ->assertJsonPath('code', 'note_changed');
        $this->putJson($noteUrl, ['body' => 'حضر بانتظام', 'important' => true, 'revision' => 1,
            'entry_revision' => $entry['revision'],
            'request_id' => (string) Str::uuid()])->assertOk()->assertJsonPath('note.revision', 2);
        $this->putJson($noteUrl, ['body' => 'حضر بانتظام', 'important' => false, 'revision' => 2,
            'entry_revision' => $entry['revision'],
            'request_id' => (string) Str::uuid()])->assertOk()->assertJsonPath('note.important', false);
        $history = $this->getJson($noteUrl)->assertOk()->assertJsonPath('entry_revision', $entry['revision'])
            ->assertJsonCount(3, 'versions');
        $this->assertNotNull($history->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $history->headers->get('X-Courses-Query-Count'));
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT attendance_note_audit_failure CHECK (event <> 'student.attendance_note_updated') NOT VALID"));
        try {
            $this->putJson($noteUrl, ['body' => 'يجب التراجع عن هذا النص', 'important' => true,
                'revision' => 3, 'entry_revision' => $entry['revision'],
                'request_id' => (string) Str::uuid()])->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT attendance_note_audit_failure'));
        }
        $this->getJson($noteUrl)->assertOk()->assertJsonPath('note.revision', 3)->assertJsonCount(3, 'versions');
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/close", [
            'revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('absent_count', 1);
        $closed = $this->getJson($attendance)->assertOk()->assertJsonCount(2, 'students');
        $this->assertNotNull($closed->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $closed->headers->get('X-Courses-Query-Count'));
        $rows = $closed->json('students');
        $this->assertSame('حضر بانتظام', collect($rows)->firstWhere('student_id', $present['id'])['note_body']);
        $absentRow = collect($rows)->firstWhere('student_id', $absent['id']);
        $this->assertSame('absent', $absentRow['status']);
        $absentNoteUrl = "{$attendance}/{$absentRow['entry_id']}/note";
        $this->putJson($absentNoteUrl, ['body' => 'غاب بعد إغلاق الكشف', 'important' => true,
            'revision' => 0, 'entry_revision' => $absentRow['entry_revision'],
            'request_id' => (string) Str::uuid()])->assertCreated();
        $this->getJson($absentNoteUrl)->assertOk()->assertJsonPath('note.important', true);
        $this->center->run(function (): void {
            $this->assertSame(2, DB::table('student_event_notes')->where('event_type', 'like', 'attendance:%')->count());
            $this->assertSame(4, DB::table('student_event_note_revisions')->count());
            $this->assertSame(1, DB::table('study_attendance_entries')->where('status', 'counted')->count());
            $this->assertSame(1, DB::table('study_attendance_entries')->where('status', 'absent')->count());
            $this->assertStringNotContainsString('حضر بانتظام', DB::table('center_audit_logs')
                ->where('event', 'student.attendance_note_updated')->value('details'));
        });
        $this->grant([$this->north => ['branch_auditor']]);
        $this->asUser($this->staff);
        $audit = $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()->json('entries');
        $this->assertNotContains('student.attendance_note_created', collect($audit)->pluck('event'));
        $this->assertNotContains('student.attendance_note_updated', collect($audit)->pluck('event'));
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->getJson($noteUrl)->assertOk()->assertJsonCount(3, 'versions');
        $this->putJson($noteUrl, ['body' => 'غير مخول', 'important' => false, 'revision' => 3,
            'entry_revision' => $entry['revision'], 'request_id' => (string) Str::uuid()])->assertNotFound();
        $this->grant([$this->south => ['attendance']]);
        $this->asUser($this->staff);
        $this->getJson($noteUrl)->assertNotFound();
        $this->getJson($absentNoteUrl)->assertNotFound();
        $this->putJson($noteUrl, ['body' => 'فرع آخر', 'important' => true, 'revision' => 3,
            'entry_revision' => $entry['revision'], 'request_id' => (string) Str::uuid()])->assertNotFound();
        $this->asUser($this->owner);
        $this->center->run(fn () => DB::table('study_attendance_entries')->where('id', $entry['id'])->update(['status' => null]));
        $this->getJson($noteUrl)->assertNotFound();
        $hidden = collect($this->getJson($attendance)->assertOk()->json('students'))->firstWhere('student_id', $present['id']);
        $this->assertNull($hidden['note_body']);
    }

    public function test_undo_and_replacement_do_not_relabel_an_earlier_attendance_note(): void
    {
        $group = $this->group($this->north, 'Replacement notes');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $group['revision'] = 2;
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $student = $this->student();
        $this->enroll($student['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $this->travelTo($scheduled->copy()->addHour());
        $path = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/attendance";
        $attemptId = $this->getJson($path)->assertOk()->json('students.0.attempt_id');
        $entry = $this->postJson($path, ['attempt_id' => $attemptId, 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated()->json('entry');
        $notePath = "{$path}/{$entry['id']}/note";
        $this->putJson($notePath, ['body' => 'سياق الحضور الأول', 'important' => true,
            'revision' => 0, 'entry_revision' => $entry['revision'],
            'request_id' => (string) Str::uuid()])->assertCreated();
        $this->postJson("{$path}/{$entry['id']}/undo", ['revision' => 2,
            'request_id' => (string) Str::uuid()])->assertOk();
        $this->getJson($notePath)->assertNotFound();
        $replacement = $this->postJson($path, ['attempt_id' => $attemptId, 'status' => 'not_counted',
            'revision' => 3, 'request_id' => (string) Str::uuid()])->assertCreated()->json('entry');
        $this->getJson($notePath)->assertOk()->assertJsonPath('note', null)
            ->assertJsonPath('entry_revision', $replacement['revision']);
        $this->assertNull($this->getJson($path)->assertOk()->json('students.0.note_body'));
        $this->putJson($notePath, ['body' => 'مسودة قديمة', 'important' => true,
            'revision' => 0, 'entry_revision' => $entry['revision'],
            'request_id' => (string) Str::uuid()])->assertConflict()
            ->assertJsonPath('code', 'attendance_occurrence_changed');
        $this->getJson($notePath)->assertOk()->assertJsonPath('note', null);
        $this->putJson($notePath, ['body' => 'سياق الحضور الثاني', 'important' => false,
            'revision' => 0, 'entry_revision' => $replacement['revision'],
            'request_id' => (string) Str::uuid()])->assertCreated();
        $this->postJson("{$path}/{$entry['id']}/undo", ['revision' => 4,
            'request_id' => (string) Str::uuid()])->assertOk();
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/close", [
            'revision' => 5, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->getJson($notePath)->assertOk()->assertJsonPath('note', null);
        $this->getJson($path)->assertOk()->assertJsonPath('students.0.status', 'absent')
            ->assertJsonPath('students.0.note_body', null);
        $this->putJson($notePath, ['body' => 'مسودة ثانية قديمة', 'important' => false,
            'revision' => 0, 'entry_revision' => $replacement['revision'],
            'request_id' => (string) Str::uuid()])->assertConflict()
            ->assertJsonPath('code', 'attendance_occurrence_changed');
        $this->center->run(function (): void {
            $this->assertSame(2, DB::table('student_event_notes')->where('event_type', 'like', 'attendance:%')->count());
            $this->assertSame(2, DB::table('student_event_note_revisions')->count());
            $occurrences = DB::table('center_audit_logs')->where('event', 'student.attendance_note_created')
                ->orderBy('id')->pluck('details')->map(fn ($details) => json_decode($details, true)['entry_revision'])->all();
            $this->assertSame([1, 3], $occurrences);
        });
    }

    public function test_attendance_note_history_cursor_stays_on_the_same_occurrence_and_avoids_shifted_pages(): void
    {
        $group = $this->group($this->north, 'Note history cursor');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $group['revision'] = 2;
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $student = $this->student();
        $this->enroll($student['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $this->travelTo($scheduled->copy()->addHour());
        $attendance = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/attendance";
        $attemptId = $this->getJson($attendance)->assertOk()->json('students.0.attempt_id');
        $entry = $this->postJson($attendance, ['attempt_id' => $attemptId, 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated()->json('entry');
        $notePath = "{$attendance}/{$entry['id']}/note";
        for ($revision = 1; $revision <= 22; $revision++) {
            $this->putJson($notePath, ['body' => "Version {$revision}", 'important' => false,
                'revision' => $revision - 1, 'entry_revision' => $entry['revision'],
                'request_id' => (string) Str::uuid()])->assertSuccessful();
        }
        $first = $this->getJson($notePath)->assertOk()->assertJsonCount(20, 'versions')
            ->assertJsonPath('pagination.next_before_revision', 3);
        $this->assertLessThanOrEqual(6, (int) $first->headers->get('X-Courses-Query-Count'));
        $oldNoteId = $first->json('note.id');
        $this->putJson($notePath, ['body' => 'Version 23', 'important' => true,
            'revision' => 22, 'entry_revision' => $entry['revision'],
            'request_id' => (string) Str::uuid()])->assertOk();
        $older = $this->getJson("{$notePath}?page=2&before_revision=3")->assertOk()
            ->assertJsonCount(2, 'versions')->assertJsonPath('versions.0.revision', 2)
            ->assertJsonPath('versions.1.revision', 1)->assertJsonPath('pagination.has_more', false);
        $this->assertSame($oldNoteId, $older->json('note.id'));
        $this->postJson("{$attendance}/{$entry['id']}/undo", ['revision' => 2,
            'request_id' => (string) Str::uuid()])->assertOk();
        $replacement = $this->postJson($attendance, ['attempt_id' => $attemptId, 'status' => 'not_counted',
            'revision' => 3, 'request_id' => (string) Str::uuid()])->assertCreated()->json('entry');
        $this->putJson($notePath, ['body' => 'Replacement occurrence', 'important' => false,
            'revision' => 0, 'entry_revision' => $replacement['revision'],
            'request_id' => (string) Str::uuid()])->assertCreated();
        $changed = $this->getJson("{$notePath}?page=2&before_revision=3")->assertOk()
            ->assertJsonPath('entry_revision', $replacement['revision'])->assertJsonCount(1, 'versions')
            ->assertJsonPath('versions.0.body', 'Replacement occurrence');
        $this->assertNotSame($oldNoteId, $changed->json('note.id'));
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
