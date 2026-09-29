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

    public function test_selected_attempt_adopts_new_plan_requirements_with_equivalence_and_preserved_history(): void
    {
        $group = $this->group($this->north, 2);
        $first = $this->student();
        $second = $this->student();
        $firstAttempt = $this->enroll($first['id'], $group, now('Africa/Cairo')->toDateString());
        $secondAttempt = $this->enroll($second['id'], $group, now('Africa/Cairo')->toDateString());
        $oldLectures = $this->center->run(fn () => DB::table('plan_lectures')
            ->where('plan_version_id', $group['plan_version_id'])->orderBy('number')->get());
        $this->center->run(function () use ($group, $firstAttempt, $oldLectures): void {
            $sessionId = (string) Str::uuid();
            $requirementId = DB::table('study_group_requirements')->where('group_id', $group['id'])
                ->where('plan_lecture_id', $oldLectures[0]->id)->value('id');
            DB::table('study_sessions')->insert(['id' => $sessionId, 'group_id' => $group['id'],
                'group_requirement_id' => $requirementId, 'plan_lecture_id' => $oldLectures[0]->id,
                'number' => 1, 'scheduled_at' => now()->subDay(), 'status' => 'held', 'revision' => 2,
                'created_by' => $this->owner->id, 'created_by_name' => $this->owner->name,
                'closed_at' => now(), 'closed_by' => $this->owner->id, 'created_at' => now(), 'updated_at' => now()]);
            DB::table('study_attendance_entries')->insert(['id' => (string) Str::uuid(),
                'session_id' => $sessionId, 'attempt_id' => $firstAttempt['id'], 'status' => 'counted',
                'revision' => 1, 'recorded_by' => $this->owner->id, 'recorded_at' => now(),
                'created_at' => now(), 'updated_at' => now()]);
        });
        $level = $this->getJson("{$this->base}/levels/{$group['level_id']}")->assertOk()->json('levels.0');
        $newPlan = $this->postJson("{$this->base}/levels/{$group['level_id']}/plan-versions", [
            'base_plan_version_id' => $group['plan_version_id'], 'base_revision' => $level['plan']['revision'],
            'lectures' => [['number' => 1, 'content' => 'محتوى بديل كامل', 'planned_hours' => 1],
                ['number' => 2, 'content' => 'محتوى جديد ثانٍ', 'planned_hours' => 1],
                ['number' => 3, 'content' => 'محتوى جديد ثالث', 'planned_hours' => 1]],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('plan');
        $newLecture = $this->center->run(fn () => DB::table('plan_lectures')
            ->where('plan_version_id', $newPlan['id'])->where('number', 1)->value('id'));
        $this->postJson("{$this->base}/content-equivalences", [
            'source_plan_version_id' => $group['plan_version_id'],
            'target_plan_version_id' => $newPlan['id'],
            'source_lecture_ids' => [$oldLectures[0]->id], 'target_lecture_ids' => [$newLecture],
            'reason' => 'اعتماد محتوى المحاضرة الكاملة بين الإصدارين', 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $path = "{$this->base}/groups/{$group['id']}/plan-applications";
        $options = $this->getJson("{$path}/options")->assertOk()
            ->assertJsonPath('versions.0.id', $newPlan['id'])->assertJsonCount(1, 'versions');
        $this->assertLessThanOrEqual(6, (int) $options->headers->get('X-Courses-Query-Count'));
        $change = ['target_plan_version_id' => $newPlan['id'], 'attempt_ids' => [$firstAttempt['id']],
            'reason' => 'اعتماد الإصدار الجديد للمحاولة المختارة'];
        $preview = $this->postJson("{$path}/preview", $change)->assertOk()
            ->assertJsonPath('students.0.before.required_count', 2)
            ->assertJsonPath('students.0.before.covered_count', 1)
            ->assertJsonPath('students.0.after.required_count', 3)
            ->assertJsonPath('students.0.after.covered_count', 1)
            ->assertJsonPath('students.0.after.missing_numbers', [2, 3])->json();
        $request = [...$change, 'group_revision' => $preview['group_revision'],
            'preview_token' => $preview['preview_token'], 'request_id' => (string) Str::uuid()];
        $this->postJson($path, $request)->assertCreated()->assertJsonPath('applied_count', 1);
        $this->postJson($path, $request)->assertOk()->assertJsonPath('applied_count', 1);
        $this->postJson($path, [...$request, 'reason' => 'سبب مختلف'])->assertConflict()
            ->assertJsonPath('code', 'plan_application_request_changed');
        $report = $this->getJson("{$this->base}/groups/{$group['id']}/coverage")->assertOk();
        $this->assertLessThanOrEqual(6, (int) $report->headers->get('X-Courses-Query-Count'));
        $this->assertStringContainsString('study_attempts.plan_version_applied',
            $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()->getContent());
        $rows = collect($report->json('students'))->keyBy('attempt_id');
        $this->assertSame(3, $rows[$firstAttempt['id']]['required_count']);
        $this->assertSame(1, $rows[$firstAttempt['id']]['covered_count']);
        $this->assertSame([2, 3], $rows[$firstAttempt['id']]['missing_numbers']);
        $this->assertSame(2, $rows[$secondAttempt['id']]['required_count']);
        $enrollments = $this->getJson("{$this->base}/students/{$first['id']}/enrollments")->assertOk();
        $this->assertSame(3, $enrollments->json('attempts.0.requirements_count'));
        $this->getJson("{$this->base}/students/{$second['id']}/enrollments")->assertOk()
            ->assertJsonPath('attempts.0.requirements_count', 2);
        $instructorId = $this->center->run(fn () => DB::table('study_group_instructors')
            ->where('group_id', $group['id'])->value('instructor_id'));
        $makeupGroup = $this->postJson("{$this->base}/groups", [
            'level_id' => $group['level_id'], 'plan_version_id' => $newPlan['id'],
            'name' => 'تعويض متطلبات الإصدار الجديد', 'approved_price' => '100.00',
            'instructor_ids' => [$instructorId], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $makeupSession = $this->postJson("{$this->base}/groups/{$makeupGroup['id']}/sessions", [
            'kind' => 'single', 'revision' => $makeupGroup['revision'],
            'start_at' => now('Africa/Cairo')->addDays(2)->setTime(16, 0)->format('Y-m-d\\TH:i'),
            'plan_lecture_number' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $attemptRevision = $this->center->run(fn () => DB::table('study_attempts')
            ->where('id', $firstAttempt['id'])->value('revision'));
        $this->postJson("{$this->base}/students/{$first['id']}/enrollments/{$firstAttempt['id']}/makeup/book", [
            'session_id' => $makeupSession['id'], 'attempt_revision' => $attemptRevision,
            'session_revision' => $makeupSession['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->center->run(function () use ($firstAttempt, $secondAttempt, $group, $newPlan): void {
            $this->assertSame($newPlan['id'], DB::table('study_attempts')->where('id', $firstAttempt['id'])->value('plan_version_id'));
            $this->assertSame($group['plan_version_id'], DB::table('study_attempts')->where('id', $secondAttempt['id'])->value('plan_version_id'));
            $this->assertSame($group['plan_version_id'], DB::table('study_groups')->where('id', $group['id'])->value('plan_version_id'));
            $this->assertSame(1, DB::table('study_attempt_plan_applications')->count());
            $this->assertSame(0, DB::table('study_attempt_fees')->where('attempt_id', $firstAttempt['id'])
                ->where('net_amount', '<>', 0)->count());
        });
        $staleChange = ['target_plan_version_id' => $newPlan['id'],
            'attempt_ids' => [$secondAttempt['id']], 'reason' => 'تطبيق الخطة على محاولة أخرى'];
        $stale = $this->postJson("{$path}/preview", $staleChange)->assertOk()->json();
        $requirementsPath = "{$this->base}/groups/{$group['id']}/requirements";
        $addition = ['kind' => 'add', 'content' => 'محاضرة إضافية للمجموعة القديمة',
            'reason' => 'زيادة موثقة للمجموعة قبل تطبيق الإصدار'];
        $additionPreview = $this->postJson("{$requirementsPath}/preview", $addition)->assertOk()->json();
        $this->postJson($requirementsPath, [...$addition,
            'group_revision' => $additionPreview['group_revision'],
            'preview_token' => $additionPreview['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->postJson($path, [...$staleChange, 'group_revision' => $stale['group_revision'],
            'preview_token' => $stale['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertConflict()->assertJsonPath('code', 'group_changed');
        $this->center->run(fn () => $this->assertSame($group['plan_version_id'],
            DB::table('study_attempts')->where('id', $secondAttempt['id'])->value('plan_version_id')));
        $this->center->run(fn () => DB::table('study_groups')->where('id', $group['id'])
            ->update(['completion_threshold' => 70, 'revision' => DB::raw('revision + 1')]));
        $thresholdPath = "{$this->base}/groups/{$group['id']}/completion-threshold";
        $thresholdChange = ['attempt_ids' => [$firstAttempt['id']],
            'reason' => 'تطبيق حد الإتمام على متطلبات المحاولة المعتمدة'];
        $thresholdPreview = $this->postJson("{$thresholdPath}/preview", $thresholdChange)->assertOk()
            ->assertJsonPath('students.0.required_count', 3)->json();
        $this->postJson($thresholdPath, [...$thresholdChange,
            'preview_token' => $thresholdPreview['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('students.0.required_count', 3);
        $this->center->run(fn () => $this->assertSame(3,
            DB::table('study_attempt_threshold_history')->where('attempt_id', $firstAttempt['id'])
                ->value('required_count')));
        $this->putJson("{$this->base}/members/{$this->viewerMembership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [$this->north => ['branch_viewer', 'branch_auditor']],
        ])->assertOk();
        $this->asUser($this->viewer);
        $this->getJson("{$path}/options")->assertForbidden();
        $this->postJson("{$path}/preview", $staleChange)->assertForbidden();
        $this->postJson($path, [...$staleChange, 'group_revision' => $stale['group_revision'],
            'preview_token' => $stale['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertForbidden();
        $this->assertStringNotContainsString('study_attempts.plan_version_applied',
            $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()->getContent());
    }

    public function test_repeated_plan_application_keeps_approved_equivalence_chain_and_both_snapshots(): void
    {
        $group = $this->group($this->north, 1);
        $student = $this->student();
        $attempt = $this->enroll($student['id'], $group, now('Africa/Cairo')->toDateString());
        $oldLecture = $this->center->run(fn () => DB::table('plan_lectures')
            ->where('plan_version_id', $group['plan_version_id'])->value('id'));
        $this->center->run(function () use ($group, $attempt, $oldLecture): void {
            $sessionId = (string) Str::uuid();
            $requirementId = DB::table('study_group_requirements')->where('group_id', $group['id'])
                ->where('plan_lecture_id', $oldLecture)->value('id');
            DB::table('study_sessions')->insert(['id' => $sessionId, 'group_id' => $group['id'],
                'group_requirement_id' => $requirementId, 'plan_lecture_id' => $oldLecture,
                'number' => 1, 'scheduled_at' => now()->subDay(), 'status' => 'held', 'revision' => 2,
                'created_by' => $this->owner->id, 'created_by_name' => $this->owner->name,
                'closed_at' => now(), 'closed_by' => $this->owner->id, 'created_at' => now(), 'updated_at' => now()]);
            DB::table('study_attendance_entries')->insert(['id' => (string) Str::uuid(),
                'session_id' => $sessionId, 'attempt_id' => $attempt['id'], 'status' => 'counted',
                'revision' => 1, 'recorded_by' => $this->owner->id, 'recorded_at' => now(),
                'created_at' => now(), 'updated_at' => now()]);
        });
        $planPath = "{$this->base}/levels/{$group['level_id']}/plan-versions";
        $createPlan = function (string $baseId, int $revision, string $content) use ($planPath): array {
            return $this->postJson($planPath, ['base_plan_version_id' => $baseId,
                'base_revision' => $revision, 'lectures' => [[
                    'number' => 1, 'content' => $content, 'planned_hours' => 1,
                ]], 'request_id' => (string) Str::uuid()])->assertCreated()->json('plan');
        };
        $secondPlan = $createPlan($group['plan_version_id'], 1, 'المحتوى الثاني');
        $thirdPlan = $createPlan($secondPlan['id'], $secondPlan['revision'], 'المحتوى الثالث');
        $secondLecture = $this->center->run(fn () => DB::table('plan_lectures')
            ->where('plan_version_id', $secondPlan['id'])->value('id'));
        $thirdLecture = $this->center->run(fn () => DB::table('plan_lectures')
            ->where('plan_version_id', $thirdPlan['id'])->value('id'));
        foreach ([[$group['plan_version_id'], $secondPlan['id'], $oldLecture, $secondLecture],
            [$secondPlan['id'], $thirdPlan['id'], $secondLecture, $thirdLecture]] as $equivalence) {
            $this->postJson("{$this->base}/content-equivalences", [
                'source_plan_version_id' => $equivalence[0], 'target_plan_version_id' => $equivalence[1],
                'source_lecture_ids' => [$equivalence[2]], 'target_lecture_ids' => [$equivalence[3]],
                'reason' => 'اعتماد سلسلة المحتوى الكامل', 'request_id' => (string) Str::uuid(),
            ])->assertCreated();
        }
        $applicationPath = "{$this->base}/groups/{$group['id']}/plan-applications";
        foreach ([$secondPlan, $thirdPlan] as $plan) {
            $change = ['target_plan_version_id' => $plan['id'], 'attempt_ids' => [$attempt['id']],
                'reason' => 'تطبيق إصدار أحدث بعد اعتماد سلسلة المعادلات'];
            $preview = $this->postJson("{$applicationPath}/preview", $change)->assertOk()
                ->assertJsonPath('students.0.after.covered_count', 1)
                ->assertJsonPath('students.0.after.required_count', 1)->json();
            $this->postJson($applicationPath, [...$change, 'group_revision' => $preview['group_revision'],
                'preview_token' => $preview['preview_token'], 'request_id' => (string) Str::uuid(),
            ])->assertCreated();
        }
        $this->getJson("{$this->base}/groups/{$group['id']}/coverage")->assertOk()
            ->assertJsonPath('students.0.plan_version', 3)
            ->assertJsonPath('students.0.covered_count', 1);
        $this->center->run(function () use ($attempt, $group, $thirdPlan): void {
            $history = DB::table('study_attempt_plan_applications')->where('attempt_id', $attempt['id'])
                ->orderBy('approved_at')->get();
            $this->assertCount(2, $history);
            $this->assertSame($group['plan_version_id'], $history[0]->from_plan_version_id);
            $this->assertSame($thirdPlan['id'], $history[1]->to_plan_version_id);
            $this->assertCount(2, json_decode($history[1]->approval_ids, true));
        });
    }

    public function test_plan_application_preserves_a_previous_exceptional_completion_decision(): void
    {
        $group = $this->group($this->north, 1);
        $student = $this->student();
        $attempt = $this->enroll($student['id'], $group, now('Africa/Cairo')->toDateString());
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => $group['revision']])->assertOk();
        $decision = ['complete_group' => true, 'decisions' => [[
            'attempt_id' => $attempt['id'], 'exception_reason' => 'اعتماد استثنائي محفوظ قبل تعديل الخطة',
        ]]];
        $completionPreview = $this->postJson("{$this->base}/groups/{$group['id']}/completion-preview", $decision)
            ->assertOk()->assertJsonPath('students.0.exceptional', true)->json();
        $this->postJson("{$this->base}/groups/{$group['id']}/completion", [...$decision,
            'group_revision' => $completionPreview['group']['revision'],
            'preview_token' => $completionPreview['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $beforeDecision = $this->center->run(fn () => DB::table('study_attempt_completion_decisions')
            ->where('attempt_id', $attempt['id'])->first());
        $newPlan = $this->postJson("{$this->base}/levels/{$group['level_id']}/plan-versions", [
            'base_plan_version_id' => $group['plan_version_id'], 'base_revision' => 1,
            'lectures' => [['number' => 1, 'content' => 'محتوى جديد أول', 'planned_hours' => 1],
                ['number' => 2, 'content' => 'محتوى جديد ثانٍ', 'planned_hours' => 1]],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('plan');
        $path = "{$this->base}/groups/{$group['id']}/plan-applications";
        $change = ['target_plan_version_id' => $newPlan['id'], 'attempt_ids' => [$attempt['id']],
            'reason' => 'تثبيت متطلبات الإصدار الجديد مع إبقاء القرار السابق'];
        $preview = $this->postJson("{$path}/preview", $change)->assertOk()
            ->assertJsonPath('students.0.completion_decision.id', $beforeDecision->id)
            ->assertJsonPath('students.0.before.required_count', 1)
            ->assertJsonPath('students.0.after.required_count', 2)->json();
        $this->postJson($path, [...$change, 'group_revision' => $preview['group_revision'],
            'preview_token' => $preview['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->getJson("{$this->base}/groups/{$group['id']}/coverage")->assertOk()
            ->assertJsonPath('students.0.required_count', 2)
            ->assertJsonPath('students.0.approved_at', $beforeDecision->approved_at);
        $this->center->run(function () use ($attempt, $beforeDecision): void {
            $saved = DB::table('study_attempt_completion_decisions')->where('attempt_id', $attempt['id'])->first();
            $this->assertSame($beforeDecision->id, $saved->id);
            $this->assertSame($beforeDecision->covered_count, $saved->covered_count);
            $this->assertSame($beforeDecision->required_count, $saved->required_count);
            $this->assertSame('completed', DB::table('study_attempts')->where('id', $attempt['id'])->value('status'));
        });
    }

    public function test_closed_group_period_freezes_the_plan_effective_on_its_boundary_date(): void
    {
        $group = $this->group($this->north, 1);
        $students = [$this->student(), $this->student()];
        $joinedOn = now('Africa/Cairo')->subDays(2)->toDateString();
        $attempts = array_map(fn (array $student): array => $this->enroll($student['id'], $group, $joinedOn), $students);
        $originalIds = $this->center->run(fn () => DB::table('study_group_requirements')
            ->where('group_id', $group['id'])->orderBy('number')->pluck('plan_lecture_id')->all());
        $newPlan = $this->postJson("{$this->base}/levels/{$group['level_id']}/plan-versions", [
            'base_plan_version_id' => $group['plan_version_id'], 'base_revision' => 1,
            'lectures' => [['number' => 1, 'content' => 'محتوى الإصدار الجديد الأول', 'planned_hours' => 1],
                ['number' => 2, 'content' => 'محتوى الإصدار الجديد الثاني', 'planned_hours' => 1]],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('plan');
        $newIds = $this->center->run(fn () => DB::table('plan_lectures')
            ->where('plan_version_id', $newPlan['id'])->orderBy('number')->pluck('id')->all());
        $path = "{$this->base}/groups/{$group['id']}/plan-applications";
        $change = ['target_plan_version_id' => $newPlan['id'],
            'attempt_ids' => array_column($attempts, 'id'), 'reason' => 'اعتماد الإصدار الجديد للمحاولتين'];
        $preview = $this->postJson("{$path}/preview", $change)->assertOk()->json();
        $this->postJson($path, [...$change, 'group_revision' => $preview['group_revision'],
            'preview_token' => $preview['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated();

        foreach ($attempts as $index => $attempt) {
            $revision = $this->center->run(fn () => DB::table('study_attempts')
                ->where('id', $attempt['id'])->value('revision'));
            $this->postJson("{$this->base}/students/{$students[$index]['id']}/enrollments/{$attempt['id']}/withdraw", [
                'withdrawn_on' => now('Africa/Cairo')->subDays($index)->toDateString(),
                'reason' => 'تثبيت متطلبات فترة الطالب عند الانسحاب',
                'revision' => $revision, 'request_id' => (string) Str::uuid(),
            ])->assertOk();
        }
        $this->center->run(function () use ($attempts, $newIds, $originalIds): void {
            $periods = DB::table('study_attempt_group_periods')
                ->whereIn('attempt_id', array_column($attempts, 'id'))->get()->keyBy('attempt_id');
            $this->assertSame($newIds, json_decode($periods[$attempts[0]['id']]->required_credit_ids, true));
            $this->assertSame($originalIds, json_decode($periods[$attempts[1]['id']]->required_credit_ids, true));
        });
        $report = $this->getJson("{$this->base}/groups/{$group['id']}/coverage")->assertOk();
        $this->assertLessThanOrEqual(6, (int) $report->headers->get('X-Courses-Query-Count'));
        $rows = collect($report->json('students'))->keyBy('attempt_id');
        $this->assertSame(2, $rows[$attempts[0]['id']]['required_count']);
        $this->assertSame(1, $rows[$attempts[1]['id']]['required_count']);
    }

    public function test_plan_application_failure_rolls_back_attempt_and_history_before_safe_retry(): void
    {
        $group = $this->group($this->north, 1);
        $student = $this->student();
        $attempt = $this->enroll($student['id'], $group, now('Africa/Cairo')->toDateString());
        $newPlan = $this->postJson("{$this->base}/levels/{$group['level_id']}/plan-versions", [
            'base_plan_version_id' => $group['plan_version_id'], 'base_revision' => 1,
            'lectures' => [['number' => 1, 'content' => 'محتوى جديد', 'planned_hours' => 1]],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('plan');
        $path = "{$this->base}/groups/{$group['id']}/plan-applications";
        $change = ['target_plan_version_id' => $newPlan['id'], 'attempt_ids' => [$attempt['id']],
            'reason' => 'تطبيق ذري مع تدقيق إلزامي'];
        $preview = $this->postJson("{$path}/preview", $change)->assertOk()->json();
        $request = [...$change, 'group_revision' => $preview['group_revision'],
            'preview_token' => $preview['preview_token'], 'request_id' => (string) Str::uuid()];
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT plan_application_audit_failure CHECK (event <> 'study_attempts.plan_version_applied') NOT VALID"));
        try {
            $this->postJson($path, $request)->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT plan_application_audit_failure'));
        }
        $this->center->run(function () use ($attempt, $group): void {
            $this->assertSame($group['plan_version_id'], DB::table('study_attempts')->where('id', $attempt['id'])->value('plan_version_id'));
            $this->assertSame(0, DB::table('study_attempt_plan_applications')->count());
            $this->assertSame(0, DB::table('study_plan_application_submissions')->count());
        });
        $this->postJson($path, $request)->assertCreated()->assertJsonPath('applied_count', 1);
        $this->center->run(fn () => $this->assertSame(1, DB::table('study_attempt_plan_applications')->count()));
    }

    public function test_historical_group_requirements_are_paged_and_searchable_after_a_frozen_withdrawal(): void
    {
        $group = $this->group($this->north, 1);
        $student = $this->student();
        $attempt = $this->enroll($student['id'], $group, now('Africa/Cairo')->toDateString());
        $ids = $this->center->run(function () use ($group): array {
            $requirements = array_map(fn (int $number): array => [
                'id' => (string) Str::uuid(), 'group_id' => $group['id'], 'number' => $number,
                'content' => "Historical requirement {$number}", 'created_at' => now(),
            ], range(2, 24));
            DB::table('study_group_requirements')->insert($requirements);

            return array_column($requirements, 'id');
        });
        $this->postJson("{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/withdraw", [
            'withdrawn_on' => now('Africa/Cairo')->toDateString(), 'reason' => 'حفظ المتطلبات قبل الإيقاف',
            'revision' => $attempt['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->center->run(function () use ($group, $ids): void {
            $snapshot = json_decode(DB::table('study_attempt_group_periods')
                ->where('group_id', $group['id'])->value('required_credit_ids'), true);
            $this->assertCount(24, $snapshot);
            foreach ($ids as $id) {
                $this->assertContains($id, $snapshot);
            }
            DB::table('study_group_requirements')->whereIn('id', $ids)->update(['retired_at' => now()]);
            DB::table('study_group_requirements')->insert(array_map(fn (int $number): array => [
                'id' => (string) Str::uuid(), 'group_id' => $group['id'], 'number' => $number,
                'content' => "Later retired requirement {$number}", 'created_at' => now(), 'retired_at' => now(),
            ], range(25, 225)));
        });

        $coverage = $this->getJson("{$this->base}/groups/{$group['id']}/coverage")->assertOk()
            ->assertJsonPath('group.required_count', 1)
            ->assertJsonPath('students.0.required_count', 24)
            ->assertJsonPath('students.0.missing_numbers', range(1, 24));
        $this->assertLessThanOrEqual(6, (int) $coverage->headers->get('X-Courses-Query-Count'));

        $sessions = $this->getJson("{$this->base}/groups/{$group['id']}/sessions")->assertOk()
            ->assertJsonCount(20, 'group.historical_requirements')
            ->assertJsonPath('group.historical_requirements_has_more', true);
        $this->assertLessThanOrEqual(6, (int) $sessions->headers->get('X-Courses-Query-Count'));
        $path = "{$this->base}/groups/{$group['id']}/requirement-equivalences/requirements";
        $first = $this->getJson($path)->assertOk()->assertJsonCount(20, 'requirements')
            ->assertJsonPath('pagination.has_more', true);
        $this->assertLessThanOrEqual(6, (int) $first->headers->get('X-Courses-Query-Count'));
        $second = $this->getJson("{$path}?page=2")->assertOk()->assertJsonCount(3, 'requirements')
            ->assertJsonPath('pagination.has_more', false);
        $this->assertLessThanOrEqual(6, (int) $second->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$path}?q=Historical%20requirement%2023")->assertOk()
            ->assertJsonCount(1, 'requirements')->assertJsonPath('requirements.0.number', 23);
        $hidden = $this->group($this->south, 1);
        $this->putJson("{$this->base}/members/{$this->viewerMembership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [$this->north => ['branch_viewer']],
        ])->assertOk();
        $this->asUser($this->viewer);
        $this->getJson($path)->assertForbidden();
        $this->getJson("{$this->base}/groups/{$hidden['id']}/requirement-equivalences/requirements")
            ->assertNotFound();
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
