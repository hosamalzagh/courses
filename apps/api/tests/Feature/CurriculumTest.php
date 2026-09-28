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
            $attemptsMigration = glob(database_path('migrations/tenant/*_create_study_attempts.php'))[0];
            (require $attemptsMigration)->down();
            DB::table('migrations')->where('migration', pathinfo($attemptsMigration, PATHINFO_FILENAME))->delete();
            foreach (['study_group_instructors', 'study_groups', 'curriculum_submissions', 'plan_lectures', 'study_plan_versions', 'levels', 'stages', 'courses'] as $table) {
                DB::statement('DROP TABLE '.$table);
            }
            DB::statement('DROP FUNCTION protect_used_plan_lecture()');
            DB::statement('DROP FUNCTION protect_used_plan_version()');
            DB::table('migrations')->where('migration', '2026_09_26_201718_create_branch_curricula')->delete();
            DB::table('migrations')->where('migration', '2026_09_28_010000_create_study_groups')->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $level = $this->sequence($this->north, 'Alpha curriculum');
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->getJson("{$this->base}/levels/{$level['id']}")->assertOk()->assertJsonCount(2, 'branches');
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Beta', 'slug' => 'beta', 'subdomain' => 'beta', 'plan' => 'starter', 'owner_email' => 'owner@beta.test',
        ])->assertCreated();
        $beta = Center::where('slug', 'beta')->firstOrFail();
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
