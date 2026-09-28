<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class CurriculumTest extends TestCase
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

    public function test_academic_employee_creates_the_branch_sequence_and_first_whole_numbered_plan(): void
    {
        $this->grant([$this->north => ['academic_admin']]);
        $this->asUser($this->staff);
        $course = $this->postJson("{$this->base}/courses", ['branch_id' => $this->north, 'name' => 'اللغة العربية', 'request_id' => (string) Str::uuid()])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", ['name' => 'التمهيدية', 'request_id' => (string) Str::uuid()])->assertCreated()->json('stage');
        $level = $this->postJson("{$this->base}/stages/{$stage['id']}/levels", [
            'name' => 'المستوى الأول', 'request_id' => (string) Str::uuid(),
            'lectures' => [['number' => 1, 'content' => 'الحروف', 'title' => null, 'planned_hours' => 1.5], ['number' => 2, 'content' => 'الكلمات', 'title' => 'قراءة', 'planned_hours' => 2]],
        ])->assertCreated()->json('level');
        $this->assertSame(1, $level['plan']['version']);
        $this->assertTrue(Str::isUuid($level['plan']['id']));
        $this->getJson("{$this->base}/levels/{$level['id']}")->assertOk()->assertJsonPath('levels.0.plan.id', $level['plan']['id'])
            ->assertJsonPath('levels.0.plan.lectures.0.number', 1)->assertJsonPath('levels.0.plan.lectures.0.title', null)
            ->assertJsonPath('levels.0.course_name', 'اللغة العربية')->assertJsonPath('levels.0.stage_name', 'التمهيدية');
        $this->getJson("{$this->base}/curriculum-workspace")->assertOk()->assertJsonCount(1, 'courses')->assertJsonCount(1, 'stages')->assertJsonCount(1, 'levels');
    }

    public function test_retry_and_stale_preview_preserve_the_original_version_and_lecture_identity(): void
    {
        $requestId = (string) Str::uuid();
        $coursePayload = ['name' => 'Retry', 'branch_id' => $this->north, 'request_id' => $requestId];
        $course = $this->postJson("{$this->base}/courses", $coursePayload)->assertCreated()->json('course');
        $this->postJson("{$this->base}/courses", $coursePayload)->assertOk()->assertJsonPath('course.id', $course['id']);
        $this->postJson("{$this->base}/courses", [...$coursePayload, 'name' => 'Different'])->assertConflict()->assertJsonPath('code', 'curriculum_request_changed');
        $this->getJson("{$this->base}/curriculum/submissions/{$requestId}")->assertOk()->assertJsonPath('record.id', $course['id']);
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", ['name' => 'Stage', 'request_id' => (string) Str::uuid()])->assertCreated()->json('stage');
        $level = $this->level($stage['id']);
        $edit = ['plan_version_id' => $level['plan']['id'], 'revision' => 1, 'lectures' => [['number' => 1, 'content' => 'New content', 'title' => null, 'planned_hours' => 2]]];
        $updated = $this->patchJson("{$this->base}/levels/{$level['id']}/first-plan", $edit)->assertOk()->json('level');
        $this->assertSame($level['plan']['id'], $updated['plan']['id']);
        $this->assertSame(2, $updated['plan']['revision']);
        $this->patchJson("{$this->base}/levels/{$level['id']}/first-plan", $edit)->assertOk()->assertJsonPath('level.plan.lectures.0.id', $updated['plan']['lectures'][0]['id']);
        $this->patchJson("{$this->base}/levels/{$level['id']}/first-plan", [...$edit, 'lectures' => [['number' => 1, 'content' => 'Stale overwrite', 'planned_hours' => 1]]])->assertConflict()->assertJsonPath('code', 'curriculum_changed');
        $events = collect($this->getJson("{$this->base}/audit")->assertOk()->json('entries'))->where('event', 'curriculum.plan_updated');
        $this->assertCount(1, $events);
        $details = json_decode($events->first()['details'], true);
        $this->assertSame('Content', $details['before']['plan']['lectures'][0]['content']);
        $this->assertSame('New content', $details['after']['plan']['lectures'][0]['content']);
    }

    public function test_new_plan_version_preserves_group_and_attempt_requirements_and_can_be_reviewed(): void
    {
        $level = $this->sequence($this->north, 'Versioned');
        $instructor = $this->postJson("{$this->base}/instructors", [
            'name' => 'Teacher', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('instructor');
        $group = $this->postJson("{$this->base}/groups", [
            'level_id' => $level['id'], 'plan_version_id' => $level['plan']['id'], 'name' => 'Original group',
            'approved_price' => '0.00', 'instructor_ids' => [$instructor['id']], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $student = $this->postJson("{$this->base}/students", [
            'name' => 'Plan student', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('student');
        $enrollmentUrl = "{$this->base}/students/{$student['id']}/enrollments";
        $studentWorkspace = $this->getJson($enrollmentUrl)->assertOk()->json('student');
        $attempt = $this->postJson($enrollmentUrl, [
            'group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $studentWorkspace['currency_revision'], 'joined_on' => now('Africa/Cairo')->format('Y-m-d'),
            'discount' => '0.00', 'discount_reason' => null, 'version' => $studentWorkspace['version'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $path = "{$this->base}/levels/{$level['id']}/plan-versions";
        $payload = ['base_plan_version_id' => $level['plan']['id'], 'base_revision' => 1,
            'request_id' => (string) Str::uuid(),
            'lectures' => [['number' => 1, 'content' => 'Revised content', 'title' => 'New title', 'planned_hours' => 3],
                ['number' => 2, 'content' => 'Additional whole lecture', 'title' => null, 'planned_hours' => 1]],
        ];
        $saved = $this->postJson($path, $payload)->assertCreated()->assertJsonPath('plan.version', 2)
            ->assertJsonPath('level.latest_version', 2)->json('plan');
        $this->postJson($path, $payload)->assertOk()->assertJsonPath('plan.id', $saved['id']);
        $this->postJson($path, [...$payload, 'lectures' => [['number' => 1, 'content' => 'Changed retry', 'planned_hours' => 1]]])
            ->assertConflict()->assertJsonPath('code', 'curriculum_request_changed');
        $this->postJson($path, [...$payload, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'curriculum_changed');
        $detail = $this->getJson("{$this->base}/levels/{$level['id']}")->assertOk()
            ->assertJsonPath('levels.0.plan.id', $saved['id'])
            ->assertJsonPath('levels.0.plan.previous_lectures.0.content', 'Content')
            ->assertJsonPath('levels.0.plan_history.0.version', 2)
            ->assertJsonPath('levels.0.plan_history.1.version', 1);
        $this->assertNotNull($detail->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $detail->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$this->base}/levels/{$level['id']}?plan_version=1")->assertOk()
            ->assertJsonPath('levels.0.plan.id', $level['plan']['id'])
            ->assertJsonPath('levels.0.plan.lectures.0.content', 'Content')
            ->assertJsonPath('levels.0.latest_version', 2);
        $this->getJson("{$this->base}/curriculum-workspace")->assertOk()->assertJsonPath('levels.0.plan.id', $saved['id']);
        $this->getJson("{$this->base}/levels/{$level['id']}?plan_version=3")->assertNotFound();
        $this->getJson("{$this->base}/levels/{$level['id']}?plan_version=3000000000")->assertUnprocessable();
        $this->getJson("{$this->base}/curriculum/submissions/{$payload['request_id']}")->assertOk()
            ->assertJsonPath('record.plan.id', $saved['id']);
        $this->getJson("{$this->base}/groups/{$group['id']}")->assertOk()
            ->assertJsonPath('groups.0.plan_version_id', $level['plan']['id'])
            ->assertJsonPath('groups.0.approved_lectures.0.content', 'Content');
        $this->getJson($enrollmentUrl)->assertOk()->assertJsonPath('attempts.0.plan_version_id', $level['plan']['id'])
            ->assertJsonPath('attempts.0.requirements_count', 1);
        $this->center->run(function () use ($group, $attempt, $level, $saved): void {
            $this->assertSame($level['plan']['id'], DB::table('study_groups')->where('id', $group['id'])->value('plan_version_id'));
            $this->assertSame($level['plan']['id'], DB::table('study_attempts')->where('id', $attempt['id'])->value('plan_version_id'));
            $this->assertSame(2, DB::table('study_plan_versions')->where('level_id', $level['id'])->count());
            $this->assertSame(2, DB::table('plan_lectures')->where('plan_version_id', $saved['id'])->count());
            try {
                DB::table('plan_lectures')->where('plan_version_id', $level['plan']['id'])->update(['content' => 'Bypass']);
                $this->fail('Superseded lectures must stay immutable.');
            } catch (QueryException $exception) {
                $this->assertStringContainsString('Used study plan is immutable', $exception->getMessage());
            }
        });
        $audit = collect($this->getJson("{$this->base}/audit")->assertOk()->json('entries'))
            ->firstWhere('event', 'curriculum.plan_version_created');
        $this->assertNotNull($audit);
        $auditDetails = json_decode($audit['details'], true);
        $this->assertSame($level['plan']['id'], $auditDetails['before']['plan']['id']);
        $this->assertSame($saved['id'], $auditDetails['after']['plan']['id']);
    }

    public function test_plan_version_creation_rechecks_scope_revision_and_superseded_immutability(): void
    {
        $hidden = $this->sequence($this->south, 'Hidden plan');
        $visible = $this->sequence($this->north, 'Visible plan');
        $payload = ['base_plan_version_id' => $visible['plan']['id'], 'base_revision' => 1,
            'request_id' => (string) Str::uuid(),
            'lectures' => [['number' => 1, 'content' => 'Revised', 'planned_hours' => 2]],
        ];
        $this->grant([$this->north => ['academic_admin']]);
        $this->asUser($this->staff);
        $hiddenPath = "{$this->base}/levels/{$hidden['id']}/plan-versions";
        $this->getJson("{$this->base}/levels/{$hidden['id']}")->assertNotFound();
        $this->postJson($hiddenPath, [...$payload, 'base_plan_version_id' => $hidden['plan']['id']])->assertNotFound();
        $path = "{$this->base}/levels/{$visible['id']}/plan-versions";
        $this->postJson($path, [...$payload, 'base_revision' => 2])->assertConflict()->assertJsonPath('code', 'curriculum_changed');
        $this->postJson($path, [...$payload, 'lectures' => [['number' => 1, 'content' => 'Content', 'planned_hours' => 2]]])
            ->assertUnprocessable();
        $this->postJson($path, [...$payload, 'lectures' => [['number' => 2, 'content' => 'Bad numbering', 'planned_hours' => 2]]])
            ->assertUnprocessable();
        $saved = $this->postJson($path, $payload)->assertCreated()->json('plan');
        $this->patchJson("{$this->base}/levels/{$visible['id']}/first-plan", [
            'plan_version_id' => $visible['plan']['id'], 'revision' => 1,
            'lectures' => [['number' => 1, 'content' => 'Silent rewrite', 'planned_hours' => 2]],
        ])->assertConflict()->assertJsonPath('code', 'plan_used');
        $this->center->run(function () use ($visible, $saved): void {
            $this->assertNull(DB::table('study_plan_versions')->where('id', $visible['plan']['id'])->value('used_at'));
            try {
                DB::table('plan_lectures')->where('plan_version_id', $visible['plan']['id'])->update(['content' => 'Bypass']);
                $this->fail('An unused but superseded version must still be immutable.');
            } catch (QueryException $exception) {
                $this->assertStringContainsString('Superseded study plan is immutable', $exception->getMessage());
            }
            $this->assertNotNull(DB::table('study_plan_versions')->where('id', $saved['id'])->value('sealed_at'));
            try {
                DB::table('plan_lectures')->where('plan_version_id', $saved['id'])->update(['content' => 'Silent rewrite']);
                $this->fail('A new version must be immutable immediately after saving.');
            } catch (QueryException $exception) {
                $this->assertStringContainsString('Sealed study plan is immutable', $exception->getMessage());
            }
            try {
                DB::table('study_plan_versions')->where('id', $saved['id'])->update(['sealed_at' => null]);
                $this->fail('A finalized version must not be reopened.');
            } catch (QueryException $exception) {
                $this->assertStringContainsString('protected content are immutable', $exception->getMessage());
            }
            $this->assertSame('Revised', DB::table('plan_lectures')->where('plan_version_id', $saved['id'])->value('content'));
        });
        $instructor = $this->postJson("{$this->base}/instructors", [
            'name' => 'Old plan teacher', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('instructor');
        $this->postJson("{$this->base}/groups", [
            'level_id' => $visible['id'], 'plan_version_id' => $visible['plan']['id'], 'name' => 'Old plan group',
            'approved_price' => '0.00', 'instructor_ids' => [$instructor['id']], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->assertJsonPath('group.plan_version_id', $visible['plan']['id']);
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/levels/{$visible['id']}")->assertOk()->assertJsonPath('levels.0.can_manage', false);
        $this->postJson($path, [...$payload, 'request_id' => (string) Str::uuid(),
            'base_plan_version_id' => $saved['id']])->assertForbidden();
        $this->grant([]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/levels/{$visible['id']}")->assertNotFound();
        $this->postJson($path, $payload)->assertNotFound();
    }

    public function test_curricula_are_branch_scoped_and_current_permissions_are_checked_again_on_writes(): void
    {
        $hidden = $this->sequence($this->south, 'Hidden');
        $visible = $this->sequence($this->north, 'Visible');
        $this->grant([$this->north => ['academic_admin', 'branch_auditor']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/curriculum-workspace")->assertOk()->assertJsonCount(1, 'courses')->assertJsonCount(1, 'stages')->assertJsonCount(1, 'levels')->assertJsonPath('levels.0.name', 'Visible');
        $this->getJson("{$this->base}/levels/{$hidden['id']}")->assertNotFound();
        $this->postJson("{$this->base}/stages/{$hidden['stage_id']}/levels", ['name' => 'Leak', 'request_id' => (string) Str::uuid(), 'lectures' => [['number' => 1, 'content' => 'X', 'planned_hours' => 1]]])->assertNotFound();
        $this->postJson("{$this->base}/courses", ['branch_id' => $this->south, 'name' => 'Leak', 'request_id' => (string) Str::uuid()])->assertForbidden();
        $audit = $this->getJson("{$this->base}/audit")->assertOk()->json('entries');
        $this->assertStringNotContainsString('Hidden', json_encode($audit));
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/levels/{$visible['id']}")->assertOk()->assertJsonPath('levels.0.can_manage', false);
        $this->patchJson("{$this->base}/levels/{$visible['id']}/first-plan", ['revision' => 1, 'plan_version_id' => $visible['plan']['id'], 'lectures' => [['number' => 1, 'content' => 'Denied', 'planned_hours' => 1]]])->assertForbidden();
        $this->grant([]);
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/levels/{$visible['id']}")->assertNotFound();
        $this->getJson("{$this->base}/curriculum-workspace")->assertOk()->assertJsonCount(0, 'levels');
    }

    public function test_first_plans_validate_whole_numbered_lectures_and_used_content_cannot_be_rewritten(): void
    {
        $level = $this->sequence($this->north);
        $planId = $level['plan']['id'];
        $path = "{$this->base}/levels/{$level['id']}/first-plan";
        foreach ([0, 1.5, 2] as $number) {
            $this->patchJson($path, ['revision' => 1, 'plan_version_id' => $planId, 'lectures' => [['number' => $number, 'content' => 'Invalid', 'planned_hours' => 1]]])->assertUnprocessable();
        }
        foreach ([0, -1, 1.123, 'INF'] as $hours) {
            $this->patchJson($path, ['revision' => 1, 'plan_version_id' => $planId, 'lectures' => [['number' => 1, 'content' => 'Invalid', 'planned_hours' => $hours]]])->assertUnprocessable();
        }
        $this->patchJson($path, ['revision' => 1, 'plan_version_id' => $planId, 'lectures' => [['number' => 1, 'content' => 'A', 'planned_hours' => 1], ['number' => 1, 'content' => 'B', 'planned_hours' => 1]]])->assertUnprocessable();
        $this->postJson("{$this->base}/stages/{$level['stage_id']}/levels", ['name' => 'No plan', 'request_id' => (string) Str::uuid(), 'lectures' => []])->assertUnprocessable();
        $this->getJson("{$this->base}/curriculum-workspace")->assertOk()->assertJsonCount(1, 'levels')->assertJsonPath('levels.0.plan.revision', 1);
        $this->center->run(fn () => DB::table('study_plan_versions')->where('id', $planId)->update(['used_at' => now()]));
        $this->patchJson($path, ['revision' => 1, 'plan_version_id' => $planId, 'lectures' => [['number' => 1, 'content' => 'Changed after use', 'planned_hours' => 1]]])->assertConflict()->assertJsonPath('code', 'plan_used');
        $this->getJson("{$this->base}/levels/{$level['id']}")->assertOk()->assertJsonPath('levels.0.plan.id', $planId)->assertJsonPath('levels.0.plan.lectures.0.content', 'Content');
        $this->center->run(function () use ($planId): void {
            try {
                DB::transaction(fn () => DB::table('plan_lectures')->where('plan_version_id', $planId)->update(['content' => 'Bypass']));
                $this->fail('The database must protect used plan lectures from future consumers.');
            } catch (QueryException $exception) {
                $this->assertStringContainsString('Used study plan is immutable', $exception->getMessage());
            }
        });
    }

    public function test_curriculum_migration_supports_existing_and_new_centers_without_linking_their_data(): void
    {
        $this->center->run(function (): void {
            $transfersMigration = glob(database_path('migrations/tenant/*_create_study_attempt_transfers.php'))[0];
            (require $transfersMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($transfersMigration, PATHINFO_FILENAME))->delete();
            $waitlistMigration = glob(database_path('migrations/tenant/*_create_study_attempt_waitlists.php'))[0];
            (require $waitlistMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($waitlistMigration, PATHINFO_FILENAME))->delete();
            $equivalencesMigration = glob(database_path('migrations/tenant/*_create_content_equivalences.php'))[0];
            (require $equivalencesMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($equivalencesMigration, PATHINFO_FILENAME))->delete();
            $adjustmentsMigration = glob(database_path('migrations/tenant/*_create_study_fee_adjustments.php'))[0];
            (require $adjustmentsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($adjustmentsMigration, PATHINFO_FILENAME))->delete();
            $attendanceMigration = glob(database_path('migrations/tenant/*_create_study_attendance.php'))[0];
            (require $attendanceMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($attendanceMigration, PATHINFO_FILENAME))->delete();
            $allocationsMigration = glob(database_path('migrations/tenant/*_create_student_payment_allocations.php'))[0];
            (require $allocationsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($allocationsMigration, PATHINFO_FILENAME))->delete();
            $sessionsMigration = glob(database_path('migrations/tenant/*_create_study_sessions.php'))[0];
            (require $sessionsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($sessionsMigration, PATHINFO_FILENAME))->delete();
            $withdrawalsMigration = glob(database_path('migrations/tenant/*_add_study_attempt_withdrawals_and_repeats.php'))[0];
            (require $withdrawalsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($withdrawalsMigration, PATHINFO_FILENAME))->delete();
            $attemptsMigration = glob(database_path('migrations/tenant/*_create_study_attempts.php'))[0];
            (require $attemptsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($attemptsMigration, PATHINFO_FILENAME))->delete();
            foreach (['study_group_instructors', 'study_groups', 'curriculum_submissions', 'plan_lectures', 'study_plan_versions', 'levels', 'stages', 'courses'] as $table) {
                DB::statement('DROP TABLE '.$table);
            }
            DB::statement('DROP FUNCTION protect_used_plan_lecture()');
            DB::statement('DROP FUNCTION protect_used_plan_version()');
            DB::table('migrations')->where('migration', '2026_09_26_201718_create_branch_curricula')->delete();
            DB::table('migrations')->where('migration', '2026_09_28_192604_protect_superseded_study_plans')->delete();
            DB::table('migrations')->where('migration', '2026_09_28_010000_create_study_groups')->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->center->run(function (): void {
            $this->assertTrue(DB::getSchemaBuilder()->hasTable('content_equivalences'));
            $this->assertTrue(DB::getSchemaBuilder()->hasTable('study_attendance_entries'));
            $this->assertTrue(DB::table('pg_indexes')->where('indexname', 'study_periods_group_date_attempt_idx')->exists());
            $this->assertStringContainsString('Superseded study plan is immutable', DB::selectOne("SELECT pg_get_functiondef('protect_used_plan_lecture()'::regprocedure) AS definition")->definition);
        });
        $level = $this->sequence($this->north, 'Alpha curriculum');
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->getJson("{$this->base}/levels/{$level['id']}")->assertOk()->assertJsonCount(2, 'branches');
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Beta', 'slug' => 'beta', 'subdomain' => 'beta', 'plan' => 'starter', 'owner_email' => 'owner@beta.test',
        ])->assertCreated();
        $beta = Center::where('slug', 'beta')->firstOrFail();
        $beta->run(function (): void {
            $this->assertTrue(DB::getSchemaBuilder()->hasTable('content_equivalences'));
            $this->assertTrue(DB::getSchemaBuilder()->hasTable('study_attendance_entries'));
            $this->assertTrue(DB::table('pg_indexes')->where('indexname', 'study_periods_group_date_attempt_idx')->exists());
            $this->assertStringContainsString('Superseded study plan is immutable', DB::selectOne("SELECT pg_get_functiondef('protect_used_plan_lecture()'::regprocedure) AS definition")->definition);
        });
        CenterMembership::create(['tenant_id' => $beta->id, 'user_id' => $this->owner->id, 'status' => 'active']);
        $beta->run(fn () => DB::table('center_grants')->insert(['user_id' => $this->owner->id, 'role' => 'center_owner']));
        $this->actingAs($this->owner, 'web')->withSession(['center_id' => $beta->id]);
        $this->getJson('http://beta.courses.test/api/v1/center/curriculum-workspace')->assertOk()->assertJsonCount(0, 'courses');
        $this->getJson("http://beta.courses.test/api/v1/center/levels/{$level['id']}")->assertNotFound();
        $branch = $this->postJson('http://beta.courses.test/api/v1/center/branches', ['name' => 'Beta', 'slug' => 'beta'])->assertCreated()->json('branch.id');
        $this->postJson('http://beta.courses.test/api/v1/center/courses', ['branch_id' => $branch, 'name' => 'Beta curriculum', 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->asUser($this->owner);
        $this->getJson("{$this->base}/curriculum-workspace")->assertOk()->assertJsonCount(1, 'courses')->assertJsonPath('courses.0.name', 'Alpha curriculum');
    }

    public function test_workspace_is_bounded_and_queries_stay_flat_as_curricula_grow(): void
    {
        $this->sequence($this->north, 'Curriculum 00');
        $one = $this->getJson("{$this->base}/curriculum-workspace")->assertOk();
        for ($index = 1; $index <= 51; $index++) {
            $this->sequence($this->north, sprintf('Curriculum %02d', $index));
        }
        $many = $this->getJson("{$this->base}/curriculum-workspace")->assertOk()->assertJsonCount(50, 'courses')->assertJsonCount(50, 'stages')->assertJsonCount(50, 'levels')
            ->assertJsonPath('levels.0.plan.lectures', [])->assertJsonPath('levels.0.plan.lecture_count', 1)->assertJsonPath('levels.0.plan.planned_hours', 2)
            ->assertJsonPath('pagination.courses.has_more', true)->assertJsonPath('pagination.stages.has_more', true)->assertJsonPath('pagination.levels.has_more', true);
        $this->assertSame($one->headers->get('X-Courses-Query-Count'), $many->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $many->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$this->base}/curriculum-workspace?courses_page=2&stages_page=2&levels_page=2")->assertOk()->assertJsonCount(2, 'courses')->assertJsonCount(2, 'stages')->assertJsonCount(2, 'levels');
        $this->getJson("{$this->base}/curriculum-workspace?levels_page=-1")->assertUnprocessable();
        $this->getJson("{$this->base}/levels/invalid")->assertNotFound();
    }

    public function test_academic_employee_creates_and_starts_a_group_with_its_own_plan_price_and_instructors(): void
    {
        $level = $this->sequence($this->north, 'Arabic');
        $instructor = $this->postJson("{$this->base}/instructors", [
            'name' => 'Mona', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('instructor');
        $this->grant([$this->north => ['academic_admin']]);
        $this->asUser($this->staff);

        $payload = [
            'level_id' => $level['id'], 'plan_version_id' => $level['plan']['id'],
            'name' => 'صباح الأحد', 'approved_price' => '0.00',
            'completion_threshold' => 80, 'instructor_ids' => [$instructor['id']],
            'request_id' => (string) Str::uuid(),
        ];
        $created = $this->postJson("{$this->base}/groups", $payload)->assertCreated()
            ->assertJsonPath('group.status', 'waiting')
            ->assertJsonPath('group.plan_version_id', $level['plan']['id'])
            ->assertJsonPath('group.approved_lecture_count', 1)
            ->assertJsonPath('group.instructors.0.name', 'Mona')
            ->json('group');
        $this->postJson("{$this->base}/groups", $payload)->assertOk()->assertJsonPath('group.id', $created['id']);
        $detail = $this->getJson("{$this->base}/groups/{$created['id']}")->assertOk()
            ->assertJsonPath('groups.0.approved_price', '0.00')
            ->assertJsonPath('groups.0.approved_lectures.0.content', 'Content')
            ->assertJsonPath('groups.0.approved_lectures.0.number', 1);
        $this->assertLessThanOrEqual(6, (int) $detail->headers->get('X-Courses-Query-Count'));
        $this->postJson("{$this->base}/groups/{$created['id']}/start", ['revision' => 1])
            ->assertOk()->assertJsonPath('group.status', 'started')->assertJsonPath('group.revision', 2);
        $this->getJson("{$this->base}/group-workspace")->assertOk()->assertJsonCount(1, 'groups');
        $workspace = $this->getJson("{$this->base}/group-workspace")->assertOk();
        $this->assertNotNull($workspace->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $workspace->headers->get('X-Courses-Query-Count'));
    }

    public function test_group_completion_threshold_inherits_course_stage_and_level_settings_with_a_group_override(): void
    {
        $level = $this->sequence($this->north, 'Inheritance');
        $instructor = $this->postJson("{$this->base}/instructors", [
            'name' => 'Hala', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('instructor');
        $group = $this->postJson("{$this->base}/groups", [
            'level_id' => $level['id'], 'plan_version_id' => $level['plan']['id'], 'name' => 'Group A',
            'approved_price' => '1500.00', 'instructor_ids' => [$instructor['id']], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->assertJsonPath('group.completion_threshold', 80)->json('group');

        $this->patchJson("{$this->base}/courses/{$level['course_id']}/completion-threshold", ['revision' => 1, 'completion_threshold' => 85])->assertOk();
        $this->getJson("{$this->base}/groups/{$group['id']}")->assertJsonPath('groups.0.completion_threshold', 85);
        $this->patchJson("{$this->base}/stages/{$level['stage_id']}/completion-threshold", ['revision' => 1, 'completion_threshold' => 90])->assertOk();
        $this->getJson("{$this->base}/groups/{$group['id']}")->assertJsonPath('groups.0.completion_threshold', 90);
        $this->patchJson("{$this->base}/levels/{$level['id']}/completion-threshold", ['revision' => 1, 'completion_threshold' => 70])->assertOk();
        $this->getJson("{$this->base}/groups/{$group['id']}")->assertJsonPath('groups.0.completion_threshold', 70);
        $this->patchJson("{$this->base}/groups/{$group['id']}/settings", [
            'revision' => 1, 'approved_price' => '0.00', 'completion_threshold' => 60,
            'instructor_ids' => [$instructor['id']],
        ])->assertOk()->assertJsonPath('group.completion_threshold', 60)->assertJsonPath('group.approved_price', '0.00');
        $this->patchJson("{$this->base}/groups/{$group['id']}/settings", [
            'revision' => 1, 'approved_price' => '500.00', 'completion_threshold' => null,
            'instructor_ids' => [$instructor['id']],
        ])->assertConflict()->assertJsonPath('code', 'group_changed');
        $this->patchJson("{$this->base}/groups/{$group['id']}/settings", [
            'revision' => 2, 'approved_price' => '0.00', 'completion_threshold' => null,
            'instructor_ids' => [$instructor['id']],
        ])->assertOk()->assertJsonPath('group.completion_threshold', 70);
    }

    public function test_groups_and_their_plan_and_instructor_choices_respect_current_branch_grants(): void
    {
        $north = $this->sequence($this->north, 'Visible');
        $south = $this->sequence($this->south, 'Hidden');
        $northInstructor = $this->postJson("{$this->base}/instructors", [
            'name' => 'Visible teacher', 'branch_ids' => [$this->north], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('instructor');
        $southInstructor = $this->postJson("{$this->base}/instructors", [
            'name' => 'Hidden teacher', 'branch_ids' => [$this->south], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('instructor');
        $payload = fn (array $level, string $instructorId): array => [
            'level_id' => $level['id'], 'plan_version_id' => $level['plan']['id'], 'name' => 'Group',
            'approved_price' => '100.00', 'instructor_ids' => [$instructorId], 'request_id' => (string) Str::uuid(),
        ];
        $visible = $this->postJson("{$this->base}/groups", $payload($north, $northInstructor['id']))->assertCreated()->json('group');
        $hidden = $this->postJson("{$this->base}/groups", $payload($south, $southInstructor['id']))->assertCreated()->json('group');
        $this->grant([$this->north => ['academic_admin']]);
        $this->asUser($this->staff);
        $workspace = $this->getJson("{$this->base}/group-workspace")->assertOk()->assertJsonCount(1, 'groups')
            ->assertJsonCount(1, 'level_choices')
            ->assertJsonPath('groups.0.id', $visible['id']);
        $this->assertStringNotContainsString('Hidden', $workspace->getContent());
        $this->getJson("{$this->base}/group-instructor-options?branch_id={$this->north}")->assertOk()
            ->assertJsonCount(1, 'instructors')->assertJsonPath('instructors.0.name', 'Visible teacher');
        $this->getJson("{$this->base}/group-instructor-options?branch_id={$this->south}")->assertNotFound();
        $this->getJson("{$this->base}/groups/{$hidden['id']}")->assertNotFound();
        $this->postJson("{$this->base}/groups/{$hidden['id']}/start", ['revision' => 1])->assertNotFound();
        $this->postJson("{$this->base}/groups", $payload($south, $southInstructor['id']))->assertNotFound();
        $this->postJson("{$this->base}/groups", $payload($north, $southInstructor['id']))->assertUnprocessable();
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $this->postJson("{$this->base}/groups/{$visible['id']}/start", ['revision' => 1])->assertForbidden();
    }

    public function test_group_instructor_options_are_searchable_and_bounded_by_branch(): void
    {
        $this->center->run(function (): void {
            $instructors = collect(range(1, 52))->map(fn (int $number): array => [
                'id' => (string) Str::uuid(), 'name' => sprintf('Teacher %02d', $number),
                'name_search' => sprintf('teacher %02d', $number), 'request_id' => (string) Str::uuid(),
                'request_hash' => str_repeat('a', 64), 'created_by' => $this->owner->id,
                'created_at' => now(), 'updated_at' => now(),
            ]);
            DB::table('instructors')->insert($instructors->all());
            DB::table('instructor_branches')->insert($instructors->map(fn (array $teacher): array => [
                'instructor_id' => $teacher['id'], 'branch_id' => $this->north, 'created_at' => now(),
            ])->all());
        });
        $first = $this->getJson("{$this->base}/group-instructor-options?branch_id={$this->north}")->assertOk()
            ->assertJsonCount(50, 'instructors')->assertJsonPath('pagination.has_more', true);
        $this->assertLessThanOrEqual(6, (int) $first->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$this->base}/group-instructor-options?branch_id={$this->north}&page=2")->assertOk()
            ->assertJsonCount(2, 'instructors')->assertJsonPath('pagination.has_more', false);
        $this->getJson("{$this->base}/group-instructor-options?branch_id={$this->north}&q=Teacher%2052")->assertOk()
            ->assertJsonCount(1, 'instructors')->assertJsonPath('instructors.0.name', 'Teacher 52');
        $this->getJson("{$this->base}/group-instructor-options?branch_id={$this->north}&q=Teacher%20%20%2052")->assertOk()
            ->assertJsonCount(1, 'instructors')->assertJsonPath('instructors.0.name', 'Teacher 52');
    }

    public function test_course_copy_previews_all_plan_versions_and_creates_independent_branch_curriculum(): void
    {
        $course = $this->postJson("{$this->base}/courses", [
            'branch_id' => $this->north, 'name' => 'منهج المصدر', 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", [
            'name' => 'المرحلة', 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('stage');
        $level = $this->postJson("{$this->base}/stages/{$stage['id']}/levels", [
            'name' => 'المستوى', 'request_id' => (string) Str::uuid(),
            'lectures' => [['number' => 1, 'content' => 'الخطة الأولى', 'planned_hours' => 1]],
        ])->assertCreated()->json('level');
        $this->postJson("{$this->base}/levels/{$level['id']}/plan-versions", [
            'base_plan_version_id' => $level['plan']['id'], 'base_revision' => 1,
            'lectures' => [['number' => 1, 'content' => 'الخطة الثانية', 'planned_hours' => 2]],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $preview = $this->getJson("{$this->base}/courses/{$course['id']}/copy-preview?target_branch_id={$this->south}")
            ->assertOk()->assertJsonPath('counts.stages', 1)->assertJsonPath('counts.levels', 1)
            ->assertJsonPath('counts.plans', 2)->assertJsonPath('counts.lectures', 2)
            ->assertJsonCount(2, 'outline');
        $this->assertLessThanOrEqual(6, (int) $preview->headers->get('X-Courses-Query-Count'));
        $requestId = (string) Str::uuid();
        $payload = ['target_branch_id' => $this->south, 'snapshot_hash' => $preview->json('snapshot_hash'),
            'request_id' => $requestId];
        $copied = $this->postJson("{$this->base}/courses/{$course['id']}/copies", $payload)
            ->assertCreated()->assertJsonPath('counts.plans', 2);
        $copiedId = $copied->json('course_id');
        $this->postJson("{$this->base}/courses/{$course['id']}/copies", $payload)
            ->assertOk()->assertJsonPath('course_id', $copiedId)->assertJsonPath('replayed', true);
        $this->postJson("{$this->base}/courses/{$course['id']}/copies", [...$payload, 'snapshot_hash' => str_repeat('a', 64)])
            ->assertConflict()->assertJsonPath('code', 'curriculum_copy_request_changed');
        $this->center->run(function () use ($course, $stage, $copiedId): void {
            $this->assertSame($this->south, (int) DB::table('courses')->where('id', $copiedId)->value('branch_id'));
            $copiedStage = DB::table('stages')->where('course_id', $copiedId)->first();
            $copiedLevel = DB::table('levels')->where('stage_id', $copiedStage->id)->first();
            $this->assertNotSame($stage['id'], $copiedStage->id);
            $this->assertSame(2, DB::table('study_plan_versions')->where('level_id', $copiedLevel->id)->count());
            $this->assertSame(1, DB::table('study_plan_versions')->where('level_id', $copiedLevel->id)
                ->where('version', '>', 1)->whereNotNull('sealed_at')->count());
            $this->assertSame(2, DB::table('plan_lectures')->join('study_plan_versions as plans', 'plans.id', '=', 'plan_lectures.plan_version_id')
                ->where('plans.level_id', $copiedLevel->id)->count());
            $this->assertSame(0, DB::table('study_plan_versions')->where('level_id', $copiedLevel->id)->whereNotNull('used_at')->count());
            $this->assertSame(0, DB::table('study_groups')->where('level_id', $copiedLevel->id)->count());
            DB::table('courses')->where('id', $course['id'])->update(['name' => 'تغيّر المصدر', 'updated_at' => now()]);
            $this->assertSame('منهج المصدر', DB::table('courses')->where('id', $copiedId)->value('name'));
            $this->assertSame(1, DB::table('curriculum_course_copies')->where('copied_course_id', $copiedId)->count());
        });
        $this->getJson("{$this->base}/curriculum-workspace")->assertOk()
            ->assertJsonFragment(['source_course_name' => 'منهج المصدر', 'source_branch_name' => 'North']);
        $this->getJson("{$this->base}/audit")->assertOk()->assertJsonFragment(['event' => 'curriculum.course_copied']);
    }

    public function test_course_copy_rechecks_source_destination_and_snapshot_without_leaking_hidden_branch(): void
    {
        $course = $this->postJson("{$this->base}/courses", [
            'branch_id' => $this->north, 'name' => 'خاص بالشمال', 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('course');
        $path = "{$this->base}/courses/{$course['id']}/copy-preview?target_branch_id={$this->south}";
        $preview = $this->getJson($path)->assertOk();
        $payload = ['target_branch_id' => $this->south, 'snapshot_hash' => $preview->json('snapshot_hash'),
            'request_id' => (string) Str::uuid()];
        $this->patchJson("{$this->base}/courses/{$course['id']}/completion-threshold", [
            'revision' => 1, 'completion_threshold' => 75,
        ])->assertOk();
        $this->postJson("{$this->base}/courses/{$course['id']}/copies", $payload)
            ->assertConflict()->assertJsonPath('code', 'curriculum_source_changed');

        $this->grant([$this->north => ['branch_viewer'], $this->south => ['academic_admin']]);
        $this->asUser($this->staff);
        $fresh = $this->getJson($path)->assertOk();
        $saved = $this->postJson("{$this->base}/courses/{$course['id']}/copies", [
            'target_branch_id' => $this->south, 'snapshot_hash' => $fresh->json('snapshot_hash'),
            'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $copiedId = $saved->json('course_id');
        $this->grant([$this->south => ['branch_auditor']]);
        $this->asUser($this->staff);
        $this->getJson($path)->assertNotFound();
        $this->postJson("{$this->base}/courses/{$course['id']}/copies", $payload)->assertNotFound();
        $workspace = $this->getJson("{$this->base}/curriculum-workspace")->assertOk();
        $copy = collect($workspace->json('courses'))->firstWhere('id', $copiedId);
        $this->assertNotNull($copy);
        $this->assertNull($copy['source_course_name']);
        $audit = $this->getJson("{$this->base}/audit")->assertOk();
        $this->assertStringNotContainsString('خاص بالشمال', $audit->getContent());
        $this->assertStringContainsString('source_hidden', $audit->getContent());
        $branchAudit = $this->getJson("{$this->base}/branches/{$this->south}/audit")->assertOk();
        $this->assertStringNotContainsString('خاص بالشمال', $branchAudit->getContent());
        $this->assertStringNotContainsString($course['id'], $branchAudit->getContent());
        $this->assertStringContainsString('source_hidden', $branchAudit->getContent());
        $this->grant([$this->north => ['branch_viewer'], $this->south => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->getJson($path)->assertNotFound();
    }

    public function test_course_copy_pages_a_large_outline_with_a_stable_snapshot(): void
    {
        $course = $this->postJson("{$this->base}/courses", [
            'branch_id' => $this->north, 'name' => 'منهج متعدد المراحل', 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('course');
        $this->center->run(function () use ($course): void {
            DB::table('stages')->insert(array_map(fn (int $number): array => [
                'id' => (string) Str::uuid(), 'course_id' => $course['id'], 'name' => "مرحلة {$number}",
                'created_at' => now()->addSeconds($number), 'updated_at' => now(),
            ], range(1, 61)));
        });
        $path = "{$this->base}/courses/{$course['id']}/copy-preview?target_branch_id={$this->south}";
        $first = $this->getJson($path)->assertOk()->assertJsonCount(50, 'outline')
            ->assertJsonPath('counts.stages', 61)->assertJsonPath('pagination.has_more', true);
        $second = $this->getJson("{$path}&page=2")->assertOk()->assertJsonCount(11, 'outline')
            ->assertJsonPath('counts.stages', 61)->assertJsonPath('pagination.has_more', false);
        $this->assertSame($first->json('snapshot_hash'), $second->json('snapshot_hash'));
        foreach ([$first, $second] as $response) {
            $this->assertLessThanOrEqual(6, (int) $response->headers->get('X-Courses-Query-Count'));
        }
        $this->postJson("{$this->base}/courses/{$course['id']}/copies", [
            'target_branch_id' => $this->south, 'snapshot_hash' => $second->json('snapshot_hash'),
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->assertJsonPath('counts.stages', 61);
    }

    private function sequence(int $branchId, string $name = 'Course'): array
    {
        $course = $this->postJson("{$this->base}/courses", ['branch_id' => $branchId, 'name' => $name, 'request_id' => (string) Str::uuid()])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", ['name' => $name, 'request_id' => (string) Str::uuid()])->assertCreated()->json('stage');

        return $this->level($stage['id'], $name);
    }

    private function level(string $stageId, string $name = 'Level'): array
    {
        return $this->postJson("{$this->base}/stages/{$stageId}/levels", ['name' => $name, 'request_id' => (string) Str::uuid(),
            'lectures' => [['number' => 1, 'content' => 'Content', 'planned_hours' => 2]],
        ])->assertCreated()->json('level');
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
