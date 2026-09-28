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
                DB::table('study_sessions')->insert(['id' => $sessionId, 'group_id' => $visible['id'], 'plan_lecture_id' => $lecture->id,
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
            DB::table('study_sessions')->insert(['id' => $sessionId, 'group_id' => $visible['id'], 'plan_lecture_id' => $lecture->id,
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
        $this->getJson("{$this->base}/groups/{$hidden['id']}/coverage")->assertNotFound();
        $this->getJson("{$this->base}/groups/not-a-uuid/coverage")->assertNotFound();
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
