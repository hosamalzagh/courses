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

class CurriculumExplorerTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    private Center $center;

    private User $owner;

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
        CenterMembership::create(['tenant_id' => $this->center->id, 'user_id' => $this->owner->id, 'status' => 'active']);
        $this->center->run(fn () => DB::table('center_grants')->insert([
            'user_id' => $this->owner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
        ]));
        $this->actingAs($this->owner, 'web')->withSession(['center_id' => $this->center->id]);
        $this->north = $this->postJson("{$this->base}/branches", ['name' => 'North', 'slug' => 'north'])->assertCreated()->json('branch.id');
        $this->south = $this->postJson("{$this->base}/branches", ['name' => 'South', 'slug' => 'south'])->assertCreated()->json('branch.id');
    }

    public function test_branch_tree_starts_with_only_its_courses_in_one_bounded_page_read(): void
    {
        $north = $this->postJson("{$this->base}/courses", [
            'name' => 'North course', 'branch_id' => $this->north, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('course');
        $this->postJson("{$this->base}/courses", [
            'name' => 'South course', 'branch_id' => $this->south, 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $workspace = $this->postJson("{$this->base}/workspaces", ['mode' => 'branch', 'branch_id' => $this->north])->assertOk()->json('workspace.id');
        $response = $this->withHeader('X-Courses-Workspace', $workspace)
            ->getJson("{$this->base}/curriculum-explorer")->assertOk()
            ->assertJsonCount(1, 'tree.root.items')
            ->assertJsonPath('tree.root.items.0.id', $north['id'])
            ->assertJsonPath('tree.root.items.0.kind', 'course')
            ->assertJsonPath('tree.root.has_more', false)
            ->assertJsonPath('tree.path', [])
            ->assertJsonPath('tree.batches', []);
        $count = $response->headers->get('X-Courses-Query-Count');
        $this->assertNotNull($count);
        $this->assertMatchesRegularExpression('/^[0-9]+$/', $count);
        $this->assertLessThanOrEqual(6, (int) $count);
    }

    public function test_disclosure_reads_only_the_selected_courses_children_and_keeps_an_empty_authorized_parent(): void
    {
        $course = $this->postJson("{$this->base}/courses", [
            'name' => 'Parent course', 'branch_id' => $this->north, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('course');
        $foreign = $this->postJson("{$this->base}/courses", [
            'name' => 'Other branch course', 'branch_id' => $this->south, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('course');
        $workspace = $this->postJson("{$this->base}/workspaces", ['mode' => 'branch', 'branch_id' => $this->north])->assertOk()->json('workspace.id');
        $this->withHeader('X-Courses-Workspace', $workspace);
        $this->getJson("{$this->base}/curriculum-explorer/children?kind=course&id={$course['id']}")
            ->assertOk()->assertJsonPath('batch.parent.id', $course['id'])->assertJsonPath('batch.items', []);
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", [
            'name' => 'Created stage', 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('stage');
        $response = $this->getJson("{$this->base}/curriculum-explorer/children?kind=course&id={$course['id']}")
            ->assertOk()->assertJsonCount(1, 'batch.items')->assertJsonPath('batch.items.0.id', $stage['id'])
            ->assertJsonPath('batch.items.0.kind', 'stage')
            ->assertJsonPath('batch.items.0.path.0.name', 'Parent course')
            ->assertJsonPath('batch.items.0.path.1.name', 'Created stage');
        $this->assertLessThanOrEqual(6, (int) $response->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$this->base}/curriculum-explorer/children?kind=course&id={$foreign['id']}")->assertNotFound();
    }

    public function test_search_reaches_an_unloaded_group_with_its_full_path_and_selects_its_existing_session_workspace(): void
    {
        $course = $this->postJson("{$this->base}/courses", ['name' => 'Language course', 'branch_id' => $this->north,
            'request_id' => (string) Str::uuid()])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", ['name' => 'First stage',
            'request_id' => (string) Str::uuid()])->assertCreated()->json('stage');
        $level = $this->postJson("{$this->base}/stages/{$stage['id']}/levels", ['name' => 'First level',
            'request_id' => (string) Str::uuid(), 'lectures' => [['number' => 1, 'content' => 'Required content', 'planned_hours' => 2]]])
            ->assertCreated()->json('level');
        $teacher = $this->postJson("{$this->base}/instructors", ['name' => 'Teacher', 'branch_ids' => [$this->north],
            'request_id' => (string) Str::uuid()])->assertCreated()->json('instructor');
        $group = $this->postJson("{$this->base}/groups", ['name' => 'Hidden group', 'level_id' => $level['id'],
            'plan_version_id' => $level['plan']['id'], 'approved_price' => '0.00', 'instructor_ids' => [$teacher['id']],
            'request_id' => (string) Str::uuid()])->assertCreated()->json('group');
        $workspace = $this->postJson("{$this->base}/workspaces", ['mode' => 'branch', 'branch_id' => $this->north])->assertOk()->json('workspace.id');
        $this->withHeader('X-Courses-Workspace', $workspace);
        $search = $this->getJson("{$this->base}/curriculum-explorer?q=Hidden")
            ->assertOk()->assertJsonPath('tree.search.q', 'Hidden')->assertJsonCount(1, 'tree.search.items')
            ->assertJsonPath('tree.search.items.0.id', $group['id'])
            ->assertJsonPath('tree.search.items.0.path.0.name', 'Language course')
            ->assertJsonPath('tree.search.items.0.path.1.name', 'First stage')
            ->assertJsonPath('tree.search.items.0.path.2.name', 'First level')
            ->assertJsonPath('tree.search.items.0.path.3.name', 'Hidden group');
        $this->assertLessThanOrEqual(6, (int) $search->headers->get('X-Courses-Query-Count'));
        $selection = $this->getJson("{$this->base}/curriculum-explorer?kind=group&id={$group['id']}")
            ->assertOk()->assertJsonCount(4, 'tree.path')->assertJsonPath('tree.path.3.id', $group['id'])
            ->assertJsonPath('session.group.id', $group['id'])->assertJsonPath('session.sessions', [])
            ->assertJsonPath('session.group.requirements.0.content', 'Required content')
            ->assertJsonPath('groups.groups.0.instructors.0.name', 'Teacher')
            ->assertJsonPath('students.items', []);
        $this->assertLessThanOrEqual(6, (int) $selection->headers->get('X-Courses-Query-Count'));
        $this->center->run(function () use ($group, $level): void {
            for ($number = 1; $number <= 21; $number++) {
                $studentId = (string) Str::uuid();
                DB::table('students')->insert(['id' => $studentId, 'name' => sprintf('Group student %02d', $number),
                    'name_search' => sprintf('Group student %02d', $number), 'request_id' => (string) Str::uuid(),
                    'request_hash' => str_repeat('0', 64), 'created_by' => $this->owner->id, 'created_at' => now(), 'updated_at' => now()]);
                DB::table('student_branches')->insert(['student_id' => $studentId, 'branch_id' => $this->north, 'created_at' => now()]);
                DB::table('study_attempts')->insert(['id' => (string) Str::uuid(), 'student_id' => $studentId,
                    'level_id' => $level['id'], 'plan_version_id' => $level['plan']['id'], 'current_group_id' => $group['id'],
                    'branch_id' => $this->north, 'joined_on' => '2026-10-01', 'status' => 'active', 'completion_threshold' => 80,
                    'created_by' => $this->owner->id, 'created_by_name' => $this->owner->name,
                    'request_id' => (string) Str::uuid(), 'request_hash' => str_repeat('0', 64), 'created_at' => now(), 'updated_at' => now()]);
            }
        });
        $firstStudents = $this->getJson("{$this->base}/curriculum-explorer?kind=group&id={$group['id']}")
            ->assertOk()->assertJsonCount(20, 'students.items')->assertJsonPath('students.items.0.name', 'Group student 01')
            ->assertJsonPath('students.items.0.student_status', 'active')->assertJsonPath('students.items.0.status', 'active')
            ->assertJsonPath('students.pagination.has_more', true);
        $lastStudent = $this->getJson("{$this->base}/curriculum-explorer?kind=group&id={$group['id']}&students_page=2")
            ->assertOk()->assertJsonCount(1, 'students.items')->assertJsonPath('students.items.0.name', 'Group student 21')
            ->assertJsonPath('students.pagination.page', 2)->assertJsonPath('students.pagination.has_more', false);
        foreach ([$firstStudents, $lastStudent] as $response) {
            $this->assertMatchesRegularExpression('/^\d+$/', $response->headers->get('X-Courses-Query-Count'));
            $this->assertLessThanOrEqual(6, (int) $response->headers->get('X-Courses-Query-Count'));
            $this->assertArrayNotHasKey('national_id', $response->json('students.items.0'));
            $this->assertArrayNotHasKey('financial_balance', $response->json('students.items.0'));
        }
    }

    public function test_selected_empty_course_and_stage_keep_their_parent_records_and_plan_detail_is_composed(): void
    {
        $course = $this->postJson("{$this->base}/courses", ['name' => 'Empty parent', 'branch_id' => $this->north,
            'request_id' => (string) Str::uuid()])->assertCreated()->json('course');
        $workspace = $this->postJson("{$this->base}/workspaces", ['mode' => 'branch', 'branch_id' => $this->north])->assertOk()->json('workspace.id');
        $this->withHeader('X-Courses-Workspace', $workspace);
        $this->getJson("{$this->base}/curriculum-explorer?kind=course&id={$course['id']}")->assertOk()
            ->assertJsonPath('curriculum.navigation.course.id', $course['id'])->assertJsonPath('curriculum.stages', []);
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", ['name' => 'Empty stage',
            'request_id' => (string) Str::uuid()])->assertCreated()->json('stage');
        $this->getJson("{$this->base}/curriculum-explorer?kind=stage&id={$stage['id']}")->assertOk()
            ->assertJsonPath('curriculum.navigation.stage.id', $stage['id'])->assertJsonPath('curriculum.levels', []);
        $level = $this->postJson("{$this->base}/stages/{$stage['id']}/levels", ['name' => 'Level with plan',
            'request_id' => (string) Str::uuid(), 'lectures' => [['number' => 1, 'content' => 'Full lecture', 'planned_hours' => 1]]])
            ->assertCreated()->json('level');
        $response = $this->getJson("{$this->base}/curriculum-explorer?kind=level&id={$level['id']}")->assertOk()
            ->assertJsonPath('curriculum.levels.0.plan.lectures.0.content', 'Full lecture')
            ->assertJsonPath('groups.navigation.level_id', $level['id'])->assertJsonPath('groups.groups', [])
            ->assertJsonPath('groups.level_choices.0.plan_version_id', $level['plan']['id']);
        $this->assertLessThanOrEqual(6, (int) $response->headers->get('X-Courses-Query-Count'));
    }

    public function test_root_children_and_global_search_are_bounded_and_legacy_parent_links_remain_authorized(): void
    {
        $ids = [];
        $this->center->run(function () use (&$ids) {
            for ($index = 0; $index < 55; $index++) {
                $id = (string) Str::uuid();
                $ids[] = $id;
                DB::table('courses')->insert(['id' => $id, 'branch_id' => $this->north,
                    'name' => sprintf('Bounded course %03d', $index), 'created_at' => now()->addSeconds($index), 'updated_at' => now()]);
            }
            DB::table('courses')->insert(['id' => (string) Str::uuid(), 'branch_id' => $this->south,
                'name' => 'Bounded south secret', 'created_at' => now(), 'updated_at' => now()]);
            for ($index = 0; $index < 55; $index++) {
                DB::table('stages')->insert(['id' => (string) Str::uuid(), 'course_id' => $ids[0],
                    'name' => sprintf('Child stage %03d', $index), 'created_at' => now()->addSeconds($index), 'updated_at' => now()]);
            }
        });
        $workspace = $this->postJson("{$this->base}/workspaces", ['mode' => 'branch', 'branch_id' => $this->north])->assertOk()->json('workspace.id');
        $this->withHeader('X-Courses-Workspace', $workspace);
        $this->getJson("{$this->base}/curriculum-explorer")->assertOk()->assertJsonCount(50, 'tree.root.items')->assertJsonPath('tree.root.has_more', true);
        $this->getJson("{$this->base}/curriculum-explorer?courses_page=2")->assertOk()->assertJsonCount(5, 'tree.root.items')->assertJsonPath('tree.root.has_more', false);
        $this->getJson("{$this->base}/curriculum-explorer/children?kind=course&id={$ids[0]}")->assertOk()
            ->assertJsonCount(50, 'batch.items')->assertJsonPath('batch.has_more', true);
        $this->getJson("{$this->base}/curriculum-explorer/children?kind=course&id={$ids[0]}&page=2")->assertOk()
            ->assertJsonCount(5, 'batch.items')->assertJsonPath('batch.has_more', false);
        $this->getJson("{$this->base}/curriculum-explorer?q=Bounded")->assertOk()
            ->assertJsonCount(50, 'tree.search.items')->assertJsonPath('tree.search.has_more', true);
        $last = $this->getJson("{$this->base}/curriculum-explorer?q=Bounded&search_page=2")->assertOk()
            ->assertJsonCount(5, 'tree.search.items')->assertJsonPath('tree.search.has_more', false);
        $this->assertNotContains('Bounded south secret', array_column($last->json('tree.search.items'), 'name'));
        $this->getJson("{$this->base}/curriculum-explorer?course_id={$ids[0]}&stages_page=2")->assertOk()
            ->assertJsonPath('tree.path.0.id', $ids[0])->assertJsonCount(5, 'curriculum.stages')
            ->assertJsonPath('curriculum.navigation.course.id', $ids[0]);
        $restored = $this->getJson("{$this->base}/curriculum-explorer?expanded=course:{$ids[0]}:2")->assertOk()
            ->assertJsonCount(1, 'tree.batches')->assertJsonPath('tree.batches.0.parent.id', $ids[0])
            ->assertJsonPath('tree.batches.0.page', 2)->assertJsonCount(5, 'tree.batches.0.items');
        $this->assertLessThanOrEqual(6, (int) $restored->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$this->base}/curriculum-explorer?kind=course&id={$ids[54]}&courses_page=1")->assertOk()
            ->assertJsonPath('tree.path.0.id', $ids[54])->assertJsonCount(50, 'tree.root.items');
        $this->getJson("{$this->base}/curriculum-explorer?kind=course")->assertUnprocessable();
        $this->assertLessThanOrEqual(6, (int) $last->headers->get('X-Courses-Query-Count'));
    }

    public function test_deleted_auxiliary_expansions_do_not_hide_the_still_authorized_selection(): void
    {
        $selected = $this->postJson("{$this->base}/courses", ['name' => 'Still selected', 'branch_id' => $this->north,
            'request_id' => (string) Str::uuid()])->assertCreated()->json('course');
        $auxiliary = $this->postJson("{$this->base}/courses", ['name' => 'Auxiliary course', 'branch_id' => $this->north,
            'request_id' => (string) Str::uuid()])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$auxiliary['id']}/stages", ['name' => 'Auxiliary stage',
            'request_id' => (string) Str::uuid()])->assertCreated()->json('stage');
        $level = $this->postJson("{$this->base}/stages/{$stage['id']}/levels", ['name' => 'Auxiliary level',
            'request_id' => (string) Str::uuid(), 'lectures' => [['number' => 1, 'content' => 'Unused plan', 'planned_hours' => 1]]])
            ->assertCreated()->json('level');
        $workspace = $this->postJson("{$this->base}/workspaces", ['mode' => 'branch', 'branch_id' => $this->north])->assertOk()->json('workspace.id');
        $expanded = "course:{$selected['id']}:1,course:{$auxiliary['id']}:1,stage:{$stage['id']}:1,level:{$level['id']}:1";
        $url = "{$this->base}/curriculum-explorer?kind=course&id={$selected['id']}&expanded={$expanded}";
        $this->withHeader('X-Courses-Workspace', $workspace)->getJson($url)->assertOk()->assertJsonCount(4, 'tree.batches');

        $writer = User::factory()->create();
        CenterMembership::create(['tenant_id' => $this->center->id, 'user_id' => $writer->id, 'status' => 'active']);
        $this->center->run(fn () => DB::table('center_grants')->insert(['user_id' => $writer->id, 'role' => 'center_owner',
            'created_at' => now(), 'updated_at' => now()]));
        $this->actingAs($writer, 'web')->withoutHeader('X-Courses-Workspace');
        $writerWorkspace = $this->postJson("{$this->base}/workspaces", ['mode' => 'branch', 'branch_id' => $this->north])->assertOk()->json('workspace.id');
        $this->withHeader('X-Courses-Workspace', $writerWorkspace);
        $this->deleteJson("{$this->base}/levels/{$level['id']}")->assertOk();
        $this->deleteJson("{$this->base}/stages/{$stage['id']}")->assertOk();
        $this->deleteJson("{$this->base}/courses/{$auxiliary['id']}")->assertOk();

        $this->actingAs($this->owner, 'web')->withHeader('X-Courses-Workspace', $workspace);
        $response = $this->getJson($url)->assertOk()->assertJsonPath('curriculum.navigation.course.id', $selected['id'])
            ->assertJsonCount(1, 'tree.path')->assertJsonCount(1, 'tree.batches')
            ->assertJsonPath('tree.batches.0.parent.id', $selected['id'])->assertJsonPath('tree.batches.0.items', []);
        foreach ([$auxiliary['id'], $stage['id'], $level['id']] as $id) {
            $this->assertStringNotContainsString($id, $response->getContent());
        }
        $count = $response->headers->get('X-Courses-Query-Count');
        $this->assertMatchesRegularExpression('/^[0-9]+$/', $count);
        $this->assertLessThanOrEqual(6, (int) $count);
        foreach (['course' => $auxiliary['id'], 'stage' => $stage['id'], 'level' => $level['id']] as $kind => $id) {
            $this->getJson("{$this->base}/curriculum-explorer?kind={$kind}&id={$id}&expanded=course:{$selected['id']}:1")->assertNotFound();
            $this->getJson("{$this->base}/curriculum-explorer/children?kind={$kind}&id={$id}")->assertNotFound();
        }
    }

    public function test_viewer_tree_permissions_foreign_selection_and_revocation_apply_to_the_composite_read(): void
    {
        $course = $this->postJson("{$this->base}/courses", ['name' => 'Visible course', 'branch_id' => $this->north,
            'request_id' => (string) Str::uuid()])->assertCreated()->json('course');
        $foreign = $this->postJson("{$this->base}/courses", ['name' => 'Hidden south', 'branch_id' => $this->south,
            'request_id' => (string) Str::uuid()])->assertCreated()->json('course');
        $viewer = User::factory()->create();
        CenterMembership::create(['tenant_id' => $this->center->id, 'user_id' => $viewer->id, 'status' => 'active']);
        $this->center->run(fn () => DB::table('branch_grants')->insert(['user_id' => $viewer->id, 'branch_id' => $this->north,
            'role' => 'branch_viewer', 'created_at' => now(), 'updated_at' => now()]));
        $this->actingAs($viewer, 'web')->withSession(['center_id' => $this->center->id]);
        $workspace = $this->postJson("{$this->base}/workspaces", ['mode' => 'branch', 'branch_id' => $this->north])->assertOk()->json('workspace.id');
        $this->withHeader('X-Courses-Workspace', $workspace);
        $response = $this->getJson("{$this->base}/curriculum-explorer?kind=course&id={$course['id']}")->assertOk()
            ->assertJsonPath('tree.root.items.0.can_manage', false)->assertJsonPath('tree.root.items.0.record.can_manage', false)
            ->assertJsonPath('curriculum.navigation.course.can_delete', false);
        $this->assertLessThanOrEqual(6, (int) $response->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$this->base}/curriculum-explorer?kind=course&id={$foreign['id']}")->assertNotFound();
        foreach (['', "kind=course&id={$course['id']}&"] as $selection) {
            $auxiliary = $this->getJson("{$this->base}/curriculum-explorer?{$selection}expanded=course:{$foreign['id']}:1")
                ->assertOk()->assertJsonPath('tree.batches', []);
            $this->assertStringNotContainsString($foreign['id'], $auxiliary->getContent());
            $this->assertStringNotContainsString('Hidden south', $auxiliary->getContent());
        }
        $this->getJson("{$this->base}/curriculum-explorer?q=Hidden")->assertOk()->assertJsonPath('tree.search.items', []);
        $this->center->run(fn () => DB::table('branch_grants')->where('user_id', $viewer->id)->delete());
        $this->getJson("{$this->base}/curriculum-explorer?kind=course&id={$course['id']}")->assertStatus(409)->assertJsonPath('code', 'workspace_expired');
    }

    public function test_selected_plan_versions_preserve_used_lifecycle_and_reject_an_unavailable_version(): void
    {
        $course = $this->postJson("{$this->base}/courses", ['name' => 'Version course', 'branch_id' => $this->north,
            'request_id' => (string) Str::uuid()])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", ['name' => 'Version stage',
            'request_id' => (string) Str::uuid()])->assertCreated()->json('stage');
        $level = $this->postJson("{$this->base}/stages/{$stage['id']}/levels", ['name' => 'Version level',
            'request_id' => (string) Str::uuid(), 'lectures' => [['number' => 1, 'content' => 'First content', 'planned_hours' => 1]]])
            ->assertCreated()->json('level');
        $this->postJson("{$this->base}/levels/{$level['id']}/plan-versions", ['base_plan_version_id' => $level['plan']['id'],
            'base_revision' => $level['plan']['revision'], 'request_id' => (string) Str::uuid(),
            'lectures' => [['number' => 1, 'content' => 'Second content', 'planned_hours' => 1]]])->assertCreated();
        $workspace = $this->postJson("{$this->base}/workspaces", ['mode' => 'branch', 'branch_id' => $this->north])->assertOk()->json('workspace.id');
        $this->withHeader('X-Courses-Workspace', $workspace);
        $response = $this->getJson("{$this->base}/curriculum-explorer?kind=level&id={$level['id']}&plan_version=1")->assertOk()
            ->assertJsonPath('curriculum.levels.0.plan.version', 1)->assertJsonPath('curriculum.levels.0.plan.lectures.0.content', 'First content')
            ->assertJsonPath('curriculum.levels.0.can_delete', false)->assertJsonCount(2, 'curriculum.levels.0.plan_history')
            ->assertJsonPath('tree.path.2.record.can_delete', false)->assertJsonPath('groups.level_choices.1.plan_version', 2);
        $this->assertLessThanOrEqual(6, (int) $response->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$this->base}/curriculum-explorer?kind=level&id={$level['id']}&plan_version=99")->assertNotFound();
    }
}
