<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class StudyCoverageTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    private Center $center;

    private User $owner;

    private User $viewer;

    private CenterMembership $viewerMembership;

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
        $this->viewer = User::factory()->create();
        CenterMembership::create(['tenant_id' => $this->center->id, 'user_id' => $this->owner->id, 'status' => 'active']);
        $this->viewerMembership = CenterMembership::create(['tenant_id' => $this->center->id, 'user_id' => $this->viewer->id, 'status' => 'active']);
        $this->center->run(fn () => DB::table('center_grants')->insert([
            'user_id' => $this->owner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
        ]));
        $this->asUser($this->owner);
        $this->north = $this->postJson("{$this->base}/branches", ['name' => 'North', 'slug' => 'north'])->assertCreated()->json('branch.id');
        $this->south = $this->postJson("{$this->base}/branches", ['name' => 'South', 'slug' => 'south'])->assertCreated()->json('branch.id');
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
    }

    public function test_counted_whole_lectures_include_open_attendance_and_preserve_late_requirements(): void
    {
        $group = $this->group($this->north, 10);
        $student = $this->student();
        $attempt = $this->enroll($student['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $start = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $sessions = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'weekly', 'revision' => 1, 'start_at' => $start->format('Y-m-d\TH:i'),
            'count' => 8, 'interval_weeks' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions');
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $this->travelTo($start->copy()->addWeeks(8));
        $path = "{$this->base}/groups/{$group['id']}/coverage";
        for ($index = 0; $index < 7; $index++) {
            $attendance = "{$this->base}/groups/{$group['id']}/sessions/{$sessions[$index]['id']}/attendance";
            $this->postJson($attendance, ['attempt_id' => $attempt['id'], 'status' => 'counted',
                'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated();
            $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$sessions[$index]['id']}/close", [
                'revision' => 2, 'request_id' => (string) Str::uuid(),
            ])->assertOk();
        }
        $seven = $this->getJson($path)->assertOk()->assertJsonPath('students.0.covered_count', 7)
            ->assertJsonPath('students.0.percentage', 70)->assertJsonPath('students.0.eligible', false)
            ->assertJsonPath('students.0.missing_numbers', [8, 9, 10]);
        $this->assertLessThanOrEqual(6, (int) $seven->headers->get('X-Courses-Query-Count'));
        $eighthAttendance = "{$this->base}/groups/{$group['id']}/sessions/{$sessions[7]['id']}/attendance";
        $entry = $this->postJson($eighthAttendance, ['attempt_id' => $attempt['id'], 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated()->json('entry');
        $this->getJson($path)->assertOk()->assertJsonPath('students.0.covered_count', 8)
            ->assertJsonPath('students.0.percentage', 80)->assertJsonPath('students.0.eligible', true)
            ->assertJsonPath('students.0.open_numbers', [8]);
        $this->postJson("{$eighthAttendance}/{$entry['id']}/undo", [
            'revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->getJson($path)->assertOk()->assertJsonPath('students.0.covered_count', 7)
            ->assertJsonPath('students.0.open_numbers', []);
        $this->postJson($eighthAttendance, ['attempt_id' => $attempt['id'], 'status' => 'counted',
            'revision' => 3, 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$sessions[7]['id']}/close", [
            'revision' => 4, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->getJson($path)->assertOk()->assertJsonPath('students.0.covered_count', 8)
            ->assertJsonPath('students.0.open_numbers', [])->assertJsonPath('students.0.eligible', true);

        $this->center->run(fn () => DB::table('study_groups')->where('id', $group['id'])
            ->update(['completion_threshold' => 90]));
        $this->getJson($path)->assertOk()->assertJsonPath('group.completion_threshold', 90)
            ->assertJsonPath('students.0.completion_threshold', 80)
            ->assertJsonPath('students.0.eligible', true);

        $late = $this->student();
        $lateAttempt = $this->enroll($late['id'], [...$group, 'revision' => 3], $start->copy()->addWeeks(7)->format('Y-m-d'));
        $result = $this->getJson("{$path}?q=".rawurlencode($late['name']))->assertOk()
            ->assertJsonCount(1, 'students')->assertJsonPath('students.0.attempt_id', $lateAttempt['id'])
            ->assertJsonPath('students.0.covered_count', 0)->assertJsonPath('students.0.required_count', 10)
            ->assertJsonPath('students.0.completion_threshold', 90);
        $this->assertSame(range(1, 10), $result->json('students.0.missing_numbers'));
        $this->center->run(fn () => $this->assertSame(0, DB::table('study_attempts')->where('status', 'completed')->count()));
    }

    public function test_suspended_session_stays_missing_until_valid_makeup_and_completion_keeps_real_counts(): void
    {
        $source = $this->group($this->north, 1);
        $instructorId = $this->center->run(fn () => DB::table('study_group_instructors')
            ->where('group_id', $source['id'])->value('instructor_id'));
        $target = $this->postJson("{$this->base}/groups", [
            'level_id' => $source['level_id'], 'plan_version_id' => $source['plan_version_id'],
            'name' => 'Makeup after suspension', 'approved_price' => '0.00',
            'instructor_ids' => [$instructorId], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $student = $this->student();
        $attempt = $this->enroll($student['id'], $source, now('Africa/Cairo')->toDateString());
        $sourceAt = now('Africa/Cairo')->addDays(2)->setTime(16, 0);
        $targetAt = $sourceAt->copy()->addDays(2);
        $sourceSession = $this->postJson("{$this->base}/groups/{$source['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $sourceAt->format('Y-m-d\\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $targetSession = $this->postJson("{$this->base}/groups/{$target['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $targetAt->format('Y-m-d\\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->postJson("{$this->base}/groups/{$source['id']}/start", ['revision' => 2])->assertOk();
        $this->postJson("{$this->base}/groups/{$target['id']}/start", ['revision' => 2])->assertOk();
        $suspended = $this->postJson("{$this->base}/students/{$student['id']}/status", [
            'status' => 'suspended', 'reason' => 'إيقاف قبل المحاضرة',
            'status_revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk()->json();
        $this->travelTo($sourceAt->copy()->addHour());
        $this->postJson("{$this->base}/groups/{$source['id']}/sessions/{$sourceSession['id']}/close", [
            'revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('absent_count', 0);
        $coveragePath = "{$this->base}/groups/{$source['id']}/coverage";
        $suspendedCoverage = $this->getJson($coveragePath)->assertOk()
            ->assertJsonPath('students.0.covered_count', 0)
            ->assertJsonPath('students.0.required_count', 1)
            ->assertJsonPath('students.0.missing_numbers', [1]);
        $this->assertLessThanOrEqual(6, (int) $suspendedCoverage->headers->get('X-Courses-Query-Count'));
        $selection = ['complete_group' => true, 'decisions' => [['attempt_id' => $attempt['id']]]];
        $this->postJson("{$this->base}/groups/{$source['id']}/completion-preview", $selection)
            ->assertConflict()->assertJsonPath('code', 'completion_exception_reason_required');
        $this->postJson("{$this->base}/students/{$student['id']}/status", [
            'status' => 'active', 'reason' => 'فك الإيقاف للتعويض',
            'status_revision' => $suspended['status_revision'], 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $afterLift = $this->getJson($coveragePath)->assertOk()
            ->assertJsonPath('students.0.covered_count', 0)->assertJsonPath('students.0.missing_numbers', [1]);
        $this->assertLessThanOrEqual(6, (int) $afterLift->headers->get('X-Courses-Query-Count'));
        $makeupPath = "{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/makeup";
        $this->postJson("{$makeupPath}/book", [
            'session_id' => $targetSession['id'], 'source_session_id' => null,
            'attempt_revision' => $attempt['revision'], 'session_revision' => 1,
            'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->getJson($coveragePath)->assertOk()
            ->assertJsonPath('students.0.covered_count', 0)->assertJsonPath('students.0.missing_numbers', [1]);
        $this->travelTo($targetAt->copy()->addHour());
        $attendance = "{$this->base}/groups/{$target['id']}/sessions/{$targetSession['id']}/attendance";
        $this->postJson($attendance, ['attempt_id' => $attempt['id'], 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->postJson("{$this->base}/groups/{$target['id']}/sessions/{$targetSession['id']}/close", [
            'revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->getJson($coveragePath)->assertOk()
            ->assertJsonPath('students.0.covered_count', 1)->assertJsonPath('students.0.missing_numbers', []);
        $preview = $this->postJson("{$this->base}/groups/{$source['id']}/completion-preview", $selection)
            ->assertOk()->assertJsonPath('students.0.exceptional', false)
            ->assertJsonPath('students.0.missing_numbers', [])->json();
        $this->postJson("{$this->base}/groups/{$source['id']}/completion", [
            ...$selection, 'group_revision' => $preview['group']['revision'],
            'preview_token' => $preview['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $courseId = $this->center->run(fn () => DB::table('levels')->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->where('levels.id', $source['level_id'])->value('stages.course_id'));
        $course = $this->getJson("{$this->base}/students/{$student['id']}/courses/{$courseId}/completion")
            ->assertOk()->assertJsonPath('course.completed', true)
            ->assertJsonPath('levels.0.attempt.covered_count', 1)
            ->assertJsonPath('levels.0.attempt.required_count', 1)
            ->assertJsonPath('levels.0.attempt.missing_numbers', []);
        $this->assertLessThanOrEqual(6, (int) $course->headers->get('X-Courses-Query-Count'));
        $this->center->run(fn () => $this->assertNull(DB::table('study_attendance_entries')
            ->where('session_id', $sourceSession['id'])->where('attempt_id', $attempt['id'])->value('status')));
    }

    public function test_eight_of_eleven_is_below_eighty_percent_and_hidden_branch_is_not_readable(): void
    {
        $visible = $this->group($this->north, 11);
        $hidden = $this->group($this->south, 11);
        $student = $this->student();
        $attempt = $this->enroll($student['id'], $visible, now('Africa/Cairo')->format('Y-m-d'));
        $this->center->run(function () use ($visible, $attempt): void {
            $lectures = DB::table('plan_lectures')->where('plan_version_id', $visible['plan_version_id'])->orderBy('number')->limit(8)->get();
            foreach ($lectures as $lecture) {
                $sessionId = (string) Str::uuid();
                $requirementId = DB::table('study_group_requirements')->where('group_id', $visible['id'])
                    ->where('plan_lecture_id', $lecture->id)->value('id');
                DB::table('study_sessions')->insert(['id' => $sessionId, 'group_id' => $visible['id'], 'plan_lecture_id' => $lecture->id,
                    'group_requirement_id' => $requirementId,
                    'number' => $lecture->number, 'scheduled_at' => now()->subDays((int) $lecture->number), 'status' => 'held',
                    'revision' => 2, 'created_by' => $this->owner->id, 'created_by_name' => $this->owner->name,
                    'closed_at' => now(), 'closed_by' => $this->owner->id, 'created_at' => now(), 'updated_at' => now()]);
                DB::table('study_attendance_entries')->insert(['id' => (string) Str::uuid(), 'session_id' => $sessionId,
                    'attempt_id' => $attempt['id'], 'status' => 'counted', 'revision' => 1,
                    'recorded_by' => $this->owner->id, 'recorded_at' => now(), 'created_at' => now(), 'updated_at' => now()]);
            }
        });
        $path = "{$this->base}/groups/{$visible['id']}/coverage";
        $read = $this->getJson($path)->assertOk()->assertJsonPath('students.0.covered_count', 8)
            ->assertJsonPath('students.0.required_count', 11)->assertJsonPath('students.0.eligible', false)
            ->assertJsonPath('students.0.missing_numbers', [9, 10, 11]);
        $this->assertSame(80, $read->json('group.completion_threshold'));
        $this->assertLessThanOrEqual(6, (int) $read->headers->get('X-Courses-Query-Count'));
        $this->center->run(function () use ($visible, $attempt): void {
            $lecture = DB::table('plan_lectures')->where('plan_version_id', $visible['plan_version_id'])->where('number', 9)->firstOrFail();
            $sessionId = (string) Str::uuid();
            $requirementId = DB::table('study_group_requirements')->where('group_id', $visible['id'])
                ->where('plan_lecture_id', $lecture->id)->value('id');
            DB::table('study_sessions')->insert(['id' => $sessionId, 'group_id' => $visible['id'], 'plan_lecture_id' => $lecture->id,
                'group_requirement_id' => $requirementId,
                'number' => 9, 'scheduled_at' => now()->subDays(9), 'status' => 'held', 'revision' => 2,
                'created_by' => $this->owner->id, 'created_by_name' => $this->owner->name,
                'closed_at' => now(), 'closed_by' => $this->owner->id, 'created_at' => now(), 'updated_at' => now()]);
            DB::table('study_attendance_entries')->insert(['id' => (string) Str::uuid(), 'session_id' => $sessionId,
                'attempt_id' => $attempt['id'], 'status' => 'counted', 'revision' => 1,
                'recorded_by' => $this->owner->id, 'recorded_at' => now(), 'created_at' => now(), 'updated_at' => now()]);
        });
        $this->getJson($path)->assertOk()->assertJsonPath('students.0.covered_count', 9)
            ->assertJsonPath('students.0.eligible', true)->assertJsonPath('students.0.missing_numbers', [10, 11]);
        $this->asUser($this->owner);
        $this->putJson("{$this->base}/members/{$this->viewerMembership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [$this->north => ['branch_viewer']],
        ])->assertOk();
        $this->asUser($this->viewer);
        $this->getJson($path)->assertOk()->assertJsonPath('students.0.student_id', $student['id']);
        $this->postJson("{$this->base}/groups/{$visible['id']}/completion-preview", [
            'complete_group' => true, 'decisions' => [],
        ])->assertForbidden();
        $this->getJson("{$this->base}/groups/{$hidden['id']}/coverage")->assertNotFound();
        $this->postJson("{$this->base}/groups/{$hidden['id']}/completion-preview", [
            'complete_group' => true, 'decisions' => [],
        ])->assertNotFound();
        $this->getJson("{$this->base}/groups/not-a-uuid/coverage")->assertNotFound();
    }

    public function test_threshold_backfill_replays_historical_overrides_for_existing_attempts(): void
    {
        $group = $this->group($this->north, 2);
        $first = $this->student();
        $original = $this->enroll($first['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $curriculum = $this->center->run(fn () => DB::table('study_groups as groups')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->where('groups.id', $group['id'])
            ->first(['levels.id as level_id', 'stages.course_id']));
        $this->patchJson("{$this->base}/courses/{$curriculum->course_id}/completion-threshold", [
            'revision' => 1, 'completion_threshold' => 85,
        ])->assertOk();
        $this->patchJson("{$this->base}/levels/{$curriculum->level_id}/completion-threshold", [
            'revision' => 1, 'completion_threshold' => 70,
        ])->assertOk();
        $this->patchJson("{$this->base}/groups/{$group['id']}/settings", [
            'revision' => 1, 'approved_price' => '0.00', 'completion_threshold' => 60,
            'instructor_ids' => array_column($group['instructors'], 'id'),
        ])->assertOk();
        $second = $this->student();
        $later = $this->enroll($second['id'], [...$group, 'revision' => 2], now('Africa/Cairo')->format('Y-m-d'));

        $this->center->run(function () use ($original, $later): void {
            DB::statement('ALTER TABLE study_attempts DROP CONSTRAINT study_attempt_completion_threshold_valid');
            DB::statement('ALTER TABLE study_attempts DROP COLUMN completion_threshold');
            $migration = require database_path('migrations/tenant/2026_09_28_180100_snapshot_attempt_completion_threshold.php');
            $migration->up();
            $thresholds = DB::table('study_attempts')->whereIn('id', [$original['id'], $later['id']])
                ->pluck('completion_threshold', 'id');
            $this->assertSame(80, $thresholds[$original['id']]);
            $this->assertSame(60, $thresholds[$later['id']]);
        });
    }

    public function test_report_paginates_students_on_the_server_without_per_row_queries(): void
    {
        $group = $this->group($this->north, 3);
        $last = null;
        for ($index = 0; $index < 21; $index++) {
            $last = $this->student();
            $this->enroll($last['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        }
        $path = "{$this->base}/groups/{$group['id']}/coverage";
        $first = $this->getJson($path)->assertOk()->assertJsonCount(20, 'students')
            ->assertJsonPath('pagination.has_more', true);
        $second = $this->getJson("{$path}?page=2")->assertOk()->assertJsonCount(1, 'students')
            ->assertJsonPath('pagination.has_more', false);
        $this->assertLessThanOrEqual(6, (int) $first->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $second->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$path}?q=".rawurlencode($last['name']))->assertOk()->assertJsonCount(1, 'students')
            ->assertJsonPath('students.0.student_id', $last['id']);
    }

    public function test_group_completion_keeps_student_decisions_explicit_and_allows_later_approval(): void
    {
        $group = $this->group($this->north, 2);
        $first = $this->student();
        $second = $this->student();
        $firstAttempt = $this->enroll($first['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $secondAttempt = $this->enroll($second['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $start = now('Africa/Cairo')->addDays(2)->setTime(16, 0);
        $sessions = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'weekly', 'revision' => 1, 'start_at' => $start->format('Y-m-d\\TH:i'),
            'count' => 2, 'interval_weeks' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions');
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $this->travelTo($start->copy()->addWeeks(2));
        $previewPath = "{$this->base}/groups/{$group['id']}/completion-preview";
        $savePath = "{$this->base}/groups/{$group['id']}/completion";
        $selection = ['complete_group' => true, 'decisions' => [['attempt_id' => $firstAttempt['id']]]];
        $openSelection = ['complete_group' => true, 'decisions' => []];
        $openPreview = $this->postJson($previewPath, $openSelection)->assertOk()
            ->assertJsonPath('open_sessions', [1, 2])->json();
        $this->postJson($savePath, [...$openSelection, 'group_revision' => $openPreview['group']['revision'],
            'preview_token' => $openPreview['preview_token'], 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'group_has_open_sessions');

        foreach ($sessions as $session) {
            $path = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/attendance";
            $this->postJson($path, ['attempt_id' => $firstAttempt['id'], 'status' => 'counted',
                'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated();
            $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/close", [
                'revision' => 2, 'request_id' => (string) Str::uuid(),
            ])->assertOk();
        }
        $this->postJson($previewPath, ['complete_group' => true, 'decisions' => []])
            ->assertOk()->assertJsonCount(0, 'students');
        $preview = $this->postJson($previewPath, $selection)->assertOk()
            ->assertJsonPath('students.0.covered_count', 2)
            ->assertJsonPath('students.0.exceptional', false)->json();
        $requestId = (string) Str::uuid();
        $save = [...$selection, 'group_revision' => $preview['group']['revision'],
            'preview_token' => $preview['preview_token'], 'request_id' => $requestId];
        $this->postJson($savePath, $save)->assertOk()->assertJsonPath('group_status', 'completed')
            ->assertJsonPath('completed_attempt_ids.0', $firstAttempt['id']);
        $this->postJson($savePath, $save)->assertOk()->assertJsonPath('completed_attempt_ids.0', $firstAttempt['id']);
        $this->postJson($savePath, [...$save, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'group_changed');
        $this->getJson("{$this->base}/groups/{$group['id']}/coverage")->assertOk()
            ->assertJsonPath('group.status', 'completed')->assertJsonPath('students.0.attempt_status', 'completed');

        $lateSelection = ['complete_group' => false, 'decisions' => [['attempt_id' => $secondAttempt['id']]]];
        $this->postJson($previewPath, $lateSelection)->assertConflict()
            ->assertJsonPath('code', 'completion_exception_reason_required');
        $lateSelection['decisions'][0]['exception_reason'] = 'إتمام استثنائي بعد مراجعة النواقص';
        $latePreview = $this->postJson($previewPath, $lateSelection)->assertOk()
            ->assertJsonPath('students.0.exceptional', true)
            ->assertJsonPath('students.0.missing_numbers', [1, 2])->json();
        $this->postJson($savePath, [...$lateSelection, 'group_revision' => $latePreview['group']['revision'],
            'preview_token' => $latePreview['preview_token'], 'request_id' => (string) Str::uuid()])
            ->assertOk()->assertJsonPath('completed_attempt_ids.0', $secondAttempt['id']);
        $this->center->run(function () use ($group, $firstAttempt, $secondAttempt): void {
            $decisions = DB::table('study_attempt_completion_decisions')->where('group_id', $group['id'])->get()->keyBy('attempt_id');
            $this->assertCount(2, $decisions);
            $this->assertFalse($decisions[$firstAttempt['id']]->exceptional);
            $this->assertTrue($decisions[$secondAttempt['id']]->exceptional);
            $this->assertSame(0, (int) $decisions[$secondAttempt['id']]->covered_count);
            $this->assertSame(1, DB::table('center_audit_logs')->where('event', 'study_group.completed')->count());
            $this->assertSame(2, DB::table('center_audit_logs')->where('event', 'study_attempt.completed')->count());
            $this->assertSame(now('Africa/Cairo')->toDateString(), DB::table('study_attempt_group_periods')
                ->where('attempt_id', $firstAttempt['id'])->value('left_on'));
            $this->assertSame(now('Africa/Cairo')->toDateString(), DB::table('study_attempt_group_periods')
                ->where('attempt_id', $secondAttempt['id'])->value('left_on'));
            $this->assertSame(2, (int) DB::table('study_attempts')->where('id', $firstAttempt['id'])->value('revision'));
            try {
                (require database_path('migrations/tenant/2026_09_29_030000_create_study_completion_decisions.php'))->down();
                $this->fail('Rollback must preserve recorded completion decisions.');
            } catch (\RuntimeException $exception) {
                $this->assertStringContainsString('Cannot roll back', $exception->getMessage());
            }
            try {
                DB::transaction(fn () => DB::table('study_attempt_completion_decisions')
                    ->where('attempt_id', $secondAttempt['id'])->update(['reason' => null]));
                $this->fail('An exceptional decision must retain its reason.');
            } catch (QueryException $exception) {
                $this->assertSame('23514', $exception->getCode());
            }
        });
        // A closed attempt keeps its approved requirement set even if legacy data changes later.
        $this->center->run(fn () => DB::table('study_group_requirements')
            ->where('group_id', $group['id'])->where('number', 2)
            ->update(['retired_at' => now()]));
        $coverage = $this->getJson("{$this->base}/groups/{$group['id']}/coverage")->assertOk()
            ->assertJsonPath('students.0.required_count', 2)
            ->assertJsonPath('students.0.covered_count', 2)
            ->assertJsonPath('students.1.required_count', 2)
            ->assertJsonPath('students.1.missing_numbers', [1, 2]);
        $this->assertLessThanOrEqual(6, (int) $coverage->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$this->base}/students/{$first['id']}/enrollments")->assertOk()
            ->assertJsonPath('attempts.0.requirements_count', 2);
    }

    public function test_completion_rejects_a_period_that_has_not_started_even_after_an_earlier_preview(): void
    {
        $group = $this->group($this->north, 1);
        $student = $this->student();
        $joinedOn = now('Africa/Cairo')->addDays(5)->toDateString();
        $attempt = $this->enroll($student['id'], $group, $joinedOn);
        $start = now('Africa/Cairo')->addDays(2)->setTime(16, 0);
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $start->format('Y-m-d\\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $selection = ['complete_group' => true, 'decisions' => [[
            'attempt_id' => $attempt['id'], 'exception_reason' => 'قرار استثنائي بعد المراجعة',
        ]]];
        $previewPath = "{$this->base}/groups/{$group['id']}/completion-preview";
        $this->postJson($previewPath, $selection)->assertConflict()
            ->assertJsonPath('code', 'completion_before_join_date');
        $this->travelTo(now('Africa/Cairo')->addDays(6));
        $preview = $this->postJson($previewPath, $selection)->assertOk()->json();
        $this->travelBack();
        $this->postJson("{$this->base}/groups/{$group['id']}/completion", [
            ...$selection, 'group_revision' => $preview['group']['revision'],
            'preview_token' => $preview['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertConflict()->assertJsonPath('code', 'completion_before_join_date');
        $this->center->run(function () use ($attempt, $joinedOn): void {
            $period = DB::table('study_attempt_group_periods')->where('attempt_id', $attempt['id'])->first();
            $this->assertSame($joinedOn, $period->joined_on);
            $this->assertNull($period->left_on);
            $this->assertSame('active', DB::table('study_attempts')->where('id', $attempt['id'])->value('status'));
            $this->assertSame(0, DB::table('study_attempt_completion_decisions')->count());
        });
    }

    public function test_group_can_complete_without_approving_any_student(): void
    {
        $group = $this->group($this->north, 1);
        $student = $this->student();
        $attempt = $this->enroll($student['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $start = now('Africa/Cairo')->addDays(2)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $start->format('Y-m-d\\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $this->travelTo($start->copy()->addDay());
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/close", [
            'revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $selection = ['complete_group' => true, 'decisions' => []];
        $preview = $this->postJson("{$this->base}/groups/{$group['id']}/completion-preview", $selection)
            ->assertOk()->assertJsonCount(0, 'students')->json();
        $this->postJson("{$this->base}/groups/{$group['id']}/completion", [
            ...$selection, 'group_revision' => $preview['group']['revision'],
            'preview_token' => $preview['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('group_status', 'completed')->assertJsonCount(0, 'completed_attempt_ids');
        $this->center->run(function () use ($attempt): void {
            $this->assertSame('active', DB::table('study_attempts')->where('id', $attempt['id'])->value('status'));
            $this->assertSame(0, DB::table('study_attempt_completion_decisions')->count());
        });
    }

    public function test_completion_keeps_counted_coverage_from_the_previous_group_after_reattachment(): void
    {
        $first = $this->group($this->north, 1);
        $second = $this->postJson("{$this->base}/groups", [
            'level_id' => $first['level_id'], 'plan_version_id' => $first['plan_version_id'],
            'name' => 'Later group', 'approved_price' => '0.00',
            'instructor_ids' => array_column($first['instructors'], 'id'), 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $student = $this->student();
        $attempt = $this->enroll($student['id'], $first, now('Africa/Cairo')->format('Y-m-d'));
        $this->center->run(function () use ($first, $attempt): void {
            $lecture = DB::table('plan_lectures')->where('plan_version_id', $first['plan_version_id'])->firstOrFail();
            $requirementId = DB::table('study_group_requirements')->where('group_id', $first['id'])
                ->where('plan_lecture_id', $lecture->id)->value('id');
            $sessionId = (string) Str::uuid();
            DB::table('study_sessions')->insert(['id' => $sessionId, 'group_id' => $first['id'],
                'plan_lecture_id' => $lecture->id, 'group_requirement_id' => $requirementId,
                'number' => 1, 'scheduled_at' => now()->subDay(),
                'status' => 'held', 'revision' => 2, 'created_by' => $this->owner->id,
                'created_by_name' => $this->owner->name, 'closed_at' => now(), 'closed_by' => $this->owner->id,
                'created_at' => now(), 'updated_at' => now()]);
            DB::table('study_attendance_entries')->insert(['id' => (string) Str::uuid(), 'session_id' => $sessionId,
                'attempt_id' => $attempt['id'], 'status' => 'counted', 'revision' => 1,
                'recorded_by' => $this->owner->id, 'recorded_at' => now(), 'created_at' => now(), 'updated_at' => now()]);
        });
        $enrollments = "{$this->base}/students/{$student['id']}/enrollments";
        $this->postJson("{$enrollments}/{$attempt['id']}/waitlist", [
            'entered_on' => now('Africa/Cairo')->format('Y-m-d'), 'reason' => 'بانتظار المجموعة التالية',
            'revision' => $attempt['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $revision = $this->getJson($enrollments)->assertOk()->json('attempts.0.revision');
        $this->postJson("{$enrollments}/{$attempt['id']}/reattach", [
            'group_id' => $second['id'], 'group_revision' => $second['revision'],
            'joined_on' => now('Africa/Cairo')->format('Y-m-d'), 'revision' => $revision,
            'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->center->run(fn () => DB::table('study_groups')->where('id', $second['id'])->update(['status' => 'started']));
        $coverage = $this->getJson("{$this->base}/groups/{$second['id']}/coverage")->assertOk()
            ->assertJsonPath('students.0.covered_count', 1)->assertJsonPath('students.0.eligible', true);
        $this->assertLessThanOrEqual(6, (int) $coverage->headers->get('X-Courses-Query-Count'));
        $selection = ['complete_group' => true, 'decisions' => [['attempt_id' => $attempt['id']]]];
        $preview = $this->postJson("{$this->base}/groups/{$second['id']}/completion-preview", $selection)
            ->assertOk()->assertJsonPath('students.0.covered_count', 1)
            ->assertJsonPath('students.0.exceptional', false)->json();
        $this->postJson("{$this->base}/groups/{$second['id']}/completion", [
            ...$selection, 'group_revision' => $preview['group']['revision'],
            'preview_token' => $preview['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->center->run(function () use ($attempt): void {
            $this->assertSame(1, (int) DB::table('study_attempt_completion_decisions')
                ->where('attempt_id', $attempt['id'])->value('covered_count'));
            $this->assertSame(0, DB::table('study_attempt_group_periods')
                ->where('attempt_id', $attempt['id'])->whereNull('left_on')->count());
        });
    }

    public function test_course_completion_requires_a_saved_decision_for_each_level_in_its_visible_branch(): void
    {
        $first = $this->group($this->north, 1);
        $curriculum = $this->center->run(fn () => DB::table('levels')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->where('levels.id', $first['level_id'])->first(['stages.id as stage_id', 'stages.course_id']));
        $level = $this->postJson("{$this->base}/stages/{$curriculum->stage_id}/levels", [
            'name' => 'Second level', 'request_id' => (string) Str::uuid(),
            'lectures' => [['number' => 1, 'content' => 'Second requirement', 'planned_hours' => 1]],
        ])->assertCreated()->json('level');
        $second = $this->postJson("{$this->base}/groups", [
            'level_id' => $level['id'], 'plan_version_id' => $level['plan']['id'],
            'name' => 'Second level group', 'approved_price' => '0.00',
            'instructor_ids' => array_column($first['instructors'], 'id'), 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $student = $this->student();
        $firstAttempt = $this->enroll($student['id'], $first, now('Africa/Cairo')->format('Y-m-d'));
        $secondAttempt = $this->enroll($student['id'], $second, now('Africa/Cairo')->format('Y-m-d'));
        $this->center->run(function () use ($first, $second, $firstAttempt): void {
            DB::table('study_groups')->whereIn('id', [$first['id'], $second['id']])->update(['status' => 'started']);
            $lecture = DB::table('plan_lectures')->where('plan_version_id', $first['plan_version_id'])->firstOrFail();
            $requirementId = DB::table('study_group_requirements')->where('group_id', $first['id'])
                ->where('plan_lecture_id', $lecture->id)->value('id');
            $sessionId = (string) Str::uuid();
            DB::table('study_sessions')->insert(['id' => $sessionId, 'group_id' => $first['id'],
                'plan_lecture_id' => $lecture->id, 'group_requirement_id' => $requirementId,
                'number' => 1, 'scheduled_at' => now()->subDay(),
                'status' => 'held', 'revision' => 2, 'created_by' => $this->owner->id,
                'created_by_name' => $this->owner->name, 'closed_at' => now(), 'closed_by' => $this->owner->id,
                'created_at' => now(), 'updated_at' => now()]);
            DB::table('study_attendance_entries')->insert(['id' => (string) Str::uuid(), 'session_id' => $sessionId,
                'attempt_id' => $firstAttempt['id'], 'status' => 'counted', 'revision' => 1,
                'recorded_by' => $this->owner->id, 'recorded_at' => now(), 'created_at' => now(), 'updated_at' => now()]);
        });
        $coursePath = "{$this->base}/students/{$student['id']}/courses/{$curriculum->course_id}/completion";
        $before = $this->getJson($coursePath)->assertOk()->assertJsonPath('course.completed', false)
            ->assertJsonPath('course.required_levels', 2)->assertJsonPath('course.completed_levels', 0)
            ->assertJsonPath('levels.0.attempt.status', 'active')
            ->assertJsonPath('levels.1.attempt.status', 'active');
        $this->assertLessThanOrEqual(6, (int) $before->headers->get('X-Courses-Query-Count'));
        $selection = ['complete_group' => true, 'decisions' => [['attempt_id' => $firstAttempt['id']]]];
        $preview = $this->postJson("{$this->base}/groups/{$first['id']}/completion-preview", $selection)
            ->assertOk()->assertJsonPath('students.0.exceptional', false)->json();
        $this->postJson("{$this->base}/groups/{$first['id']}/completion", [
            ...$selection, 'group_revision' => $preview['group']['revision'],
            'preview_token' => $preview['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $partial = $this->getJson($coursePath)->assertOk()->assertJsonPath('course.completed', false)
            ->assertJsonPath('course.completed_levels', 1);
        $this->assertFalse(collect($partial->json('levels'))->firstWhere('id', $first['level_id'])['attempt']['exceptional']);
        $this->assertLessThanOrEqual(6, (int) $partial->headers->get('X-Courses-Query-Count'));
        $exception = ['complete_group' => true, 'decisions' => [['attempt_id' => $secondAttempt['id'],
            'exception_reason' => 'إتمام استثنائي مع بقاء النقص الحقيقي']]];
        $this->postJson("{$this->base}/groups/{$second['id']}/completion-preview", [
            'complete_group' => true, 'decisions' => [['attempt_id' => $secondAttempt['id']]],
        ])->assertConflict()->assertJsonPath('code', 'completion_exception_reason_required');
        $secondPreview = $this->postJson("{$this->base}/groups/{$second['id']}/completion-preview", $exception)
            ->assertOk()->assertJsonPath('students.0.exceptional', true)->json();
        $this->postJson("{$this->base}/groups/{$second['id']}/completion", [
            ...$exception, 'group_revision' => $secondPreview['group']['revision'],
            'preview_token' => $secondPreview['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $completed = $this->getJson($coursePath)->assertOk()->assertJsonPath('course.completed', true)
            ->assertJsonPath('course.completed_levels', 2);
        $secondResult = collect($completed->json('levels'))->firstWhere('id', $level['id'])['attempt'];
        $this->assertTrue($secondResult['exceptional']);
        $this->assertSame(0, $secondResult['covered_count']);
        $this->assertSame([1], $secondResult['missing_numbers']);
        $this->assertSame($exception['decisions'][0]['exception_reason'], $secondResult['reason']);
        $this->assertLessThanOrEqual(6, (int) $completed->headers->get('X-Courses-Query-Count'));

        $hidden = $this->group($this->south, 1);
        $hiddenCourseId = $this->center->run(fn () => DB::table('levels')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->where('levels.id', $hidden['level_id'])->value('stages.course_id'));
        $this->center->run(fn () => DB::table('student_branches')->insert([
            'student_id' => $student['id'], 'branch_id' => $this->south,
            'created_at' => now(),
        ]));
        $this->putJson("{$this->base}/members/{$this->viewerMembership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [$this->north => ['branch_viewer']],
        ])->assertOk();
        $this->asUser($this->viewer);
        $this->getJson($coursePath)->assertOk()->assertJsonPath('course.completed', true);
        $this->getJson("{$this->base}/students/{$student['id']}/courses/{$hiddenCourseId}/completion")->assertNotFound();
        $this->getJson("{$this->base}/students/{$student['id']}/courses/not-a-uuid/completion")->assertNotFound();
    }

    public function test_course_completion_searches_levels_beyond_the_first_page_without_changing_the_summary(): void
    {
        $group = $this->group($this->north, 1);
        $student = $this->student();
        $curriculum = $this->center->run(fn () => DB::table('levels')->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->where('levels.id', $group['level_id'])->first(['stages.id as stage_id', 'stages.course_id']));
        $this->center->run(function () use ($curriculum): void {
            $rows = [];
            for ($index = 1; $index <= 51; $index++) {
                $created = now()->addMinute()->addSeconds($index);
                $rows[] = ['id' => (string) Str::uuid(), 'stage_id' => $curriculum->stage_id,
                    'name' => "Target {$index}", 'created_at' => $created, 'updated_at' => $created];
            }
            DB::table('levels')->insert($rows);
        });
        $path = "{$this->base}/students/{$student['id']}/courses/{$curriculum->course_id}/completion";
        $first = $this->getJson($path)->assertOk()->assertJsonPath('course.required_levels', 52)
            ->assertJsonCount(50, 'levels')->assertJsonPath('pagination.has_more', true);
        $this->assertLessThanOrEqual(6, (int) $first->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$path}?page=2")->assertOk()->assertJsonCount(2, 'levels');
        $found = $this->getJson("{$path}?q=Target%2051")->assertOk()
            ->assertJsonPath('course.required_levels', 52)->assertJsonCount(1, 'levels')
            ->assertJsonPath('levels.0.name', 'Target 51');
        $this->assertLessThanOrEqual(6, (int) $found->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$path}?q=missing")->assertOk()->assertJsonCount(0, 'levels')
            ->assertJsonPath('course.required_levels', 52);
    }

    private function group(int $branchId, int $lectureCount): array
    {
        $course = $this->postJson("{$this->base}/courses", ['branch_id' => $branchId, 'name' => 'Coverage '.Str::random(5),
            'request_id' => (string) Str::uuid()])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", [
            'name' => 'Stage', 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('stage');
        $level = $this->postJson("{$this->base}/stages/{$stage['id']}/levels", [
            'name' => 'Level', 'request_id' => (string) Str::uuid(),
            'lectures' => array_map(fn (int $number): array => ['number' => $number, 'content' => "Lecture {$number}",
                'planned_hours' => $number], range(1, $lectureCount)),
        ])->assertCreated()->json('level');
        $instructor = $this->postJson("{$this->base}/instructors", [
            'name' => 'Teacher '.Str::random(5), 'branch_ids' => [$branchId], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('instructor');

        return $this->postJson("{$this->base}/groups", [
            'level_id' => $level['id'], 'plan_version_id' => $level['plan']['id'], 'name' => 'Group '.Str::random(5),
            'approved_price' => '0.00', 'instructor_ids' => [$instructor['id']], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
    }

    private function student(): array
    {
        return $this->postJson("{$this->base}/students", [
            'name' => 'Student '.Str::random(8), 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('student');
    }

    private function enroll(string $studentId, array $group, string $joinedOn): array
    {
        $url = "{$this->base}/students/{$studentId}/enrollments";
        $workspace = $this->getJson($url)->assertOk()->json();

        return $this->postJson($url, [
            'group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $workspace['student']['currency_revision'], 'joined_on' => $joinedOn,
            'discount' => '0.00', 'discount_reason' => null, 'version' => $workspace['student']['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
    }

    private function asUser(User $user): void
    {
        $this->actingAs($user, 'web')->withSession(['center_id' => $this->center->id]);
    }
}
