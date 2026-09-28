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

class StudyAbsenceReviewTest extends TestCase
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
                'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha', 'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
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

    public function test_inherited_rule_recalculates_final_eligible_absences_and_preserves_history_after_new_period(): void
    {
        $scope = $this->group($this->north, 'North');
        $student = $this->student();
        $attemptId = $this->enroll($student['id'], $scope['group']);
        $this->seedSessions($scope, $attemptId, ['absent', 'absent', 'counted', 'absent', 'open', 'cancelled', 'outside']);

        $coursePath = "{$this->base}/absence-rules/courses/{$scope['course']['id']}";
        $stagePath = "{$this->base}/absence-rules/stages/{$scope['stage']['id']}";
        $levelPath = "{$this->base}/absence-rules/levels/{$scope['level']['id']}";
        $groupPath = "{$this->base}/absence-rules/study_groups/{$scope['group']['id']}";
        $this->patchJson($coursePath, ['mode' => 'consecutive', 'limit' => 2, 'revision' => 1])->assertOk();
        $all = $this->getJson("{$this->base}/absence-review?view=all&branch_id={$this->north}")->assertOk();
        $all->assertJsonPath('students.0.consecutive_absences', 1)
            ->assertJsonPath('students.0.total_absences', 3)
            ->assertJsonPath('students.0.needs_review', false);
        $this->center->run(fn () => DB::table('students')->where('id', $student['id'])->update(['student_number' => 1234]));
        $arabicNumber = '١٬٢٣٤';
        $this->getJson("{$this->base}/absence-review?view=all&q=".urlencode($arabicNumber))->assertOk()
            ->assertJsonCount(1, 'students')->assertJsonPath('students.0.student_id', $student['id']);
        $this->getJson("{$this->base}/absence-review?view=all&q=".urlencode('1,234'))->assertOk()
            ->assertJsonCount(1, 'students')->assertJsonPath('students.0.student_id', $student['id']);
        $this->assertLessThanOrEqual(6, (int) $all->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$this->base}/absence-review?branch_id={$this->north}")->assertOk()->assertJsonCount(0, 'students');

        $this->patchJson($stagePath, ['mode' => 'total', 'limit' => 3, 'revision' => 1])->assertOk();
        $this->getJson("{$this->base}/absence-review?stage_id={$scope['stage']['id']}")->assertOk()
            ->assertJsonCount(1, 'students')->assertJsonPath('students.0.effective_mode', 'total');
        $this->patchJson($levelPath, ['mode' => 'consecutive', 'limit' => 2, 'revision' => 1])->assertOk();
        $this->getJson("{$this->base}/absence-review")->assertOk()->assertJsonCount(0, 'students');
        $this->patchJson($groupPath, ['mode' => 'total', 'limit' => 3, 'revision' => 1])->assertOk();
        $this->getJson("{$this->base}/absence-review")->assertOk()->assertJsonCount(1, 'students');
        $this->patchJson($groupPath, ['mode' => 'disabled', 'limit' => null, 'revision' => 2])->assertOk();
        $this->getJson("{$this->base}/absence-review")->assertOk()->assertJsonCount(0, 'students');
        $this->patchJson($groupPath, ['mode' => 'total', 'limit' => 1, 'revision' => 3])->assertOk();

        $this->center->run(function () use ($attemptId, $scope): void {
            DB::table('study_attempt_group_periods')->where('attempt_id', $attemptId)->update(['left_on' => now('Africa/Cairo')->subDays(4)->format('Y-m-d')]);
            DB::table('study_attempt_group_periods')->insert([
                'id' => (string) Str::uuid(), 'attempt_id' => $attemptId, 'group_id' => $scope['group']['id'],
                'joined_on' => now('Africa/Cairo')->subDays(3)->format('Y-m-d'), 'left_on' => null, 'created_at' => now(),
            ]);
        });
        $after = $this->getJson("{$this->base}/absence-review?view=all")->assertOk();
        $after->assertJsonPath('students.0.total_absences', 0)->assertJsonPath('students.0.historical_absences', 3)
            ->assertJsonPath('students.0.needs_review', false);
        $this->getJson("{$this->base}/absence-review")->assertOk()->assertJsonCount(0, 'students');
        $this->center->run(fn () => $this->assertSame(6, DB::table('center_audit_logs')->where('event', 'study_absence.rule_changed')->count()));
    }

    public function test_rule_revision_permissions_and_hidden_branch_are_enforced(): void
    {
        $north = $this->group($this->north, 'Visible');
        $south = $this->group($this->south, 'Hidden');
        $this->center->run(fn () => DB::table('courses')->insert(array_map(fn ($index) => [
            'id' => (string) Str::uuid(), 'branch_id' => $this->north, 'name' => sprintf('A %03d', $index),
            'created_at' => now(), 'updated_at' => now(),
        ], range(1, 51))));
        $this->getJson("{$this->base}/absence-review?view=all")->assertOk()
            ->assertJsonFragment(['id' => $this->south, 'name' => 'South']);
        $path = "{$this->base}/absence-rules/courses/{$north['course']['id']}";
        $hiddenPath = "{$this->base}/absence-rules/courses/{$south['course']['id']}";
        $this->patchJson($path, ['mode' => 'total', 'limit' => 2, 'revision' => 1])->assertOk()->assertJsonPath('rule.revision', 2);
        $this->patchJson($path, ['mode' => 'total', 'limit' => 3, 'revision' => 1])->assertConflict()->assertJsonPath('code', 'absence_rule_changed');
        $this->patchJson($path, ['mode' => 'total', 'limit' => 2, 'revision' => 1])->assertOk()->assertJsonPath('rule.revision', 2);
        $this->patchJson($path, ['mode' => 'disabled', 'limit' => 2, 'revision' => 2])->assertUnprocessable();
        $this->patchJson($path, ['mode' => 'inherit', 'limit' => null, 'revision' => 2])->assertUnprocessable();
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/absence-review?view=all")->assertOk()->assertJsonCount(1, 'branches')
            ->assertJsonMissing(['id' => $south['course']['id']]);
        $this->getJson("{$this->base}/absence-options?q=Hidden")->assertOk()->assertJsonCount(0, 'options');
        $this->getJson("{$this->base}/absence-options?q=Visible")->assertOk()->assertJsonFragment(['id' => $north['course']['id']]);
        $this->getJson("{$this->base}/absence-options?q=North")->assertOk()->assertJsonCount(1, 'branches');
        $this->getJson("{$this->base}/absence-review?branch_id={$this->south}")->assertNotFound();
        $this->getJson("{$this->base}/absence-options?branch_id={$this->south}&q=Hidden")->assertNotFound();
        $this->patchJson($path, ['mode' => 'total', 'limit' => 4, 'revision' => 2])->assertForbidden();
        $this->patchJson($hiddenPath, ['mode' => 'total', 'limit' => 4, 'revision' => 1])->assertNotFound();
    }

    public function test_rule_migration_can_rollback_and_restore_an_existing_center(): void
    {
        $this->center->run(function (): void {
            $migration = require database_path('migrations/tenant/2026_09_28_190000_add_study_absence_rules.php');
            DB::connection('tenant')->transaction(function () use ($migration): void {
                $migration->down();
                $this->assertFalse(DB::connection('tenant')->getSchemaBuilder()->hasColumn('courses', 'absence_mode'));
                $migration->up();
                $this->assertTrue(DB::connection('tenant')->getSchemaBuilder()->hasColumn('courses', 'absence_mode'));
            });
        });
    }

    public function test_bulk_waitlist_rechecks_each_previewed_student_and_keeps_individual_outcomes(): void
    {
        $scope = $this->group($this->north, 'Bulk');
        $first = $this->student();
        $second = $this->student();
        $firstAttempt = $this->enroll($first['id'], $scope['group']);
        $secondAttempt = $this->enroll($second['id'], $scope['group']);
        $today = now('Africa/Cairo')->toDateString();
        $preview = $this->postJson("{$this->base}/absence-review/waitlist-batches", [
            'selection_mode' => 'all', 'branch_id' => $this->north, 'view' => 'all',
            'entered_on' => $today, 'reason' => 'مراجعة الغياب والنقل الجماعي',
        ])->assertCreated()->assertJsonPath('batch.total', 2)->assertJsonPath('batch.pending', 2);
        $batchId = $preview->json('batch.id');
        $this->assertCount(2, $preview->json('items'));

        $revision = $this->getJson("{$this->base}/absence-review?view=all&branch_id={$this->north}")
            ->assertOk()->json('students.0.attempt_revision');
        $this->postJson("{$this->base}/students/{$first['id']}/enrollments/{$firstAttempt}/waitlist", [
            'entered_on' => $today, 'reason' => 'نقل فردي سبق تنفيذ الدفعة',
            'revision' => $revision, 'request_id' => (string) Str::uuid(),
        ])->assertCreated();

        $executed = $this->postJson("{$this->base}/absence-review/waitlist-batches/{$batchId}/execute")
            ->assertOk()->assertJsonPath('batch.pending', 0)
            ->assertJsonPath('batch.moved', 1)->assertJsonPath('batch.skipped', 1);
        $this->assertContains('skipped', array_column($executed->json('items'), 'status'));
        $this->assertContains('moved', array_column($executed->json('items'), 'status'));
        $this->postJson("{$this->base}/absence-review/waitlist-batches/{$batchId}/execute")
            ->assertOk()->assertJsonPath('batch.moved', 1)->assertJsonPath('batch.skipped', 1);
        $this->getJson("{$this->base}/absence-review/waitlist-batches/{$batchId}")
            ->assertOk()->assertJsonPath('batch.pending', 0);
        $this->getJson("{$this->base}/absence-review?view=all&branch_id={$this->north}")
            ->assertOk()->assertJsonCount(0, 'students');
        $this->center->run(function () use ($firstAttempt, $secondAttempt): void {
            $this->assertSame(2, DB::table('study_attempt_waitlists')->count());
            $this->assertSame(2, DB::table('study_attempt_fees')->count());
            $this->assertNull(DB::table('study_attempts')->where('id', $firstAttempt)->value('current_group_id'));
            $this->assertNull(DB::table('study_attempts')->where('id', $secondAttempt)->value('current_group_id'));
            $this->assertSame(1, DB::table('center_audit_logs')->where('event', 'student.study_bulk_waitlist_skipped')->count());
        });
        $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()
            ->assertJsonFragment(['event' => 'student.study_bulk_waitlist_skipped']);
        $this->grant([$this->north => ['branch_viewer', 'branch_auditor']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()
            ->assertJsonMissing(['event' => 'student.study_bulk_waitlist_skipped']);
    }

    public function test_bulk_waitlist_ignores_attendance_from_a_cancelled_session(): void
    {
        $scope = $this->group($this->north, 'Cancelled');
        $student = $this->student();
        $attemptId = $this->enroll($student['id'], $scope['group']);
        $this->seedSessions($scope, $attemptId, ['cancelled']);
        $enteredOn = now('Africa/Cairo')->subDays(13)->toDateString();

        $preview = $this->postJson("{$this->base}/absence-review/waitlist-batches", [
            'selection_mode' => 'all', 'branch_id' => $this->north, 'view' => 'all',
            'entered_on' => $enteredOn, 'reason' => 'تجاهل حضور لقاء ملغى',
        ])->assertCreated()->assertJsonPath('batch.total', 1)->assertJsonPath('batch.pending', 1);
        $this->postJson("{$this->base}/absence-review/waitlist-batches/{$preview->json('batch.id')}/execute")
            ->assertOk()->assertJsonPath('batch.moved', 1)->assertJsonPath('batch.skipped', 0);
    }

    public function test_bulk_waitlist_rejects_hidden_branch_and_revoked_permissions(): void
    {
        $scope = $this->group($this->north, 'Visible');
        $student = $this->student();
        $attemptId = $this->enroll($student['id'], $scope['group']);
        $today = now('Africa/Cairo')->toDateString();
        $preview = $this->postJson("{$this->base}/absence-review/waitlist-batches", [
            'selection_mode' => 'selected', 'attempt_ids' => [$attemptId], 'branch_id' => $this->north, 'view' => 'all',
            'entered_on' => $today, 'reason' => 'فحص الصلاحيات',
        ])->assertCreated();
        $batchId = $preview->json('batch.id');
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $staffBatchId = $this->postJson("{$this->base}/absence-review/waitlist-batches", [
            'selection_mode' => 'selected', 'attempt_ids' => [$attemptId], 'branch_id' => $this->north, 'view' => 'all',
            'entered_on' => $today, 'reason' => 'معاينة موظف التسجيل',
        ])->assertCreated()->json('batch.id');
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->postJson("{$this->base}/absence-review/waitlist-batches", [
            'selection_mode' => 'all', 'branch_id' => $this->south, 'view' => 'all',
            'entered_on' => $today, 'reason' => 'فرع غير مصرح',
        ])->assertNotFound();
        $this->getJson("{$this->base}/absence-review/waitlist-batches/{$batchId}")->assertNotFound();
        $this->postJson("{$this->base}/absence-review/waitlist-batches/{$batchId}/execute")->assertNotFound();
        $this->getJson("{$this->base}/absence-review/waitlist-batches/{$staffBatchId}")->assertNotFound();
        $this->postJson("{$this->base}/absence-review/waitlist-batches/{$staffBatchId}/execute")->assertNotFound();
        $this->asUser($this->owner);
        $this->getJson("{$this->base}/absence-review/waitlist-batches/{$batchId}")->assertOk();
    }

    private function group(int $branchId, string $name): array
    {
        $course = $this->postJson("{$this->base}/courses", ['branch_id' => $branchId, 'name' => $name, 'request_id' => (string) Str::uuid()])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", ['name' => 'Stage', 'request_id' => (string) Str::uuid()])->assertCreated()->json('stage');
        $level = $this->postJson("{$this->base}/stages/{$stage['id']}/levels", [
            'name' => 'Level', 'request_id' => (string) Str::uuid(),
            'lectures' => array_map(fn ($n) => ['number' => $n, 'content' => "Lecture {$n}", 'planned_hours' => 1], range(1, 7)),
        ])->assertCreated()->json('level');
        $instructor = $this->postJson("{$this->base}/instructors", ['name' => "Teacher {$name}", 'branch_ids' => [$branchId], 'request_id' => (string) Str::uuid()])->assertCreated()->json('instructor');
        $group = $this->postJson("{$this->base}/groups", [
            'level_id' => $level['id'], 'plan_version_id' => $level['plan']['id'], 'name' => "Group {$name}",
            'approved_price' => '0.00', 'instructor_ids' => [$instructor['id']], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');

        return compact('course', 'stage', 'level', 'group');
    }

    private function student(): array
    {
        return $this->postJson("{$this->base}/students", [
            'name' => 'Student '.Str::random(8), 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('student');
    }

    private function enroll(string $studentId, array $group): string
    {
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $url = "{$this->base}/students/{$studentId}/enrollments";
        $workspace = $this->getJson($url)->assertOk()->json();
        $attempt = $this->postJson($url, [
            'group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $workspace['student']['currency_revision'],
            'joined_on' => now('Africa/Cairo')->subDays(20)->format('Y-m-d'), 'discount' => '0.00', 'discount_reason' => null,
            'version' => $workspace['student']['version'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');

        return $attempt['id'];
    }

    private function seedSessions(array $scope, string $attemptId, array $statuses): void
    {
        $this->center->run(function () use ($scope, $attemptId, $statuses): void {
            $lectures = DB::table('plan_lectures')->where('plan_version_id', $scope['level']['plan']['id'])->orderBy('number')->pluck('id');
            foreach ($statuses as $index => $status) {
                $id = (string) Str::uuid();
                $scheduled = now('Africa/Cairo')->subDays($status === 'outside' ? 25 : 12 - $index)->setTime(12, 0);
                DB::table('study_sessions')->insert([
                    'id' => $id, 'group_id' => $scope['group']['id'], 'plan_lecture_id' => $lectures[$index], 'number' => $index + 1,
                    'scheduled_at' => $scheduled, 'status' => $status === 'cancelled' ? 'cancelled' : 'held',
                    'closed_at' => $status === 'open' ? null : now(), 'revision' => 1,
                    'created_by' => $this->owner->id, 'created_by_name' => $this->owner->name,
                    'created_at' => now(), 'updated_at' => now(),
                ]);
                DB::table('study_attendance_entries')->insert([
                    'id' => (string) Str::uuid(), 'session_id' => $id, 'attempt_id' => $attemptId,
                    'status' => in_array($status, ['open', 'cancelled', 'outside'], true) ? 'absent' : $status,
                    'revision' => 1, 'created_at' => now(), 'updated_at' => now(),
                ]);
            }
        });
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
