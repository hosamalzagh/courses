<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class BranchOperationsWorkspaceTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    private Center $center;

    private User $owner;

    private array $branches;

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
        $this->branches = [];
        foreach (['North', 'South'] as $name) {
            $this->branches[] = $this->postJson("{$this->base}/branches", ['name' => $name, 'slug' => strtolower($name)])
                ->assertCreated()->json('branch.id');
        }
    }

    public function test_branch_student_reads_and_edits_preserve_shared_profile_without_revealing_other_sources(): void
    {
        $shared = $this->postJson("{$this->base}/students", ['name' => 'Shared student', 'branch_ids' => $this->branches,
            'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $southOnly = $this->postJson("{$this->base}/students", ['name' => 'South student', 'branch_ids' => [$this->branches[1]],
            'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $this->patchJson("{$this->base}/student-search-policy", ['enabled' => true, 'revision' => 1])->assertOk();
        $this->select($this->branches[0]);
        $basic = $this->getJson("{$this->base}/student-search-workspace?q=South")->assertOk()
            ->assertJsonCount(1, 'students')->assertJsonPath('students.0.within_scope', false);
        $this->assertSame(['id', 'student_number', 'name', 'phone', 'within_scope'], array_keys($basic->json('students.0')));
        $this->assertBudget($basic);
        $list = $this->getJson("{$this->base}/student-workspace")->assertOk()
            ->assertJsonCount(1, 'students')->assertJsonCount(1, 'branches')
            ->assertJsonPath('students.0.id', $shared['id'])->assertJsonPath('students.0.branch_ids', [$this->branches[0]]);
        $this->assertBudget($list);
        $this->getJson("{$this->base}/students/{$southOnly['id']}")->assertNotFound();
        $this->getJson("{$this->base}/students/{$southOnly['id']}/barcode")->assertNotFound();
        $this->patchJson("{$this->base}/students/{$shared['id']}", ['name' => 'Updated shared student', 'branch_ids' => [], 'revision' => 1])
            ->assertOk()->assertJsonPath('student.branch_ids', [$this->branches[0]]);
        $this->select($this->branches[1]);
        $this->getJson("{$this->base}/students/{$shared['id']}")->assertOk()
            ->assertJsonPath('students.0.name', 'Updated shared student')->assertJsonPath('students.0.branch_ids', [$this->branches[1]]);
    }

    public function test_branch_creates_people_in_current_branch_and_rejects_foreign_branch_associations(): void
    {
        $this->select($this->branches[0]);
        $this->postJson("{$this->base}/students", ['name' => 'Current student', 'request_id' => (string) Str::uuid()])
            ->assertCreated()->assertJsonPath('student.branch_ids', [$this->branches[0]]);
        $this->postJson("{$this->base}/students", ['name' => 'Forged student', 'branch_ids' => [$this->branches[1]], 'request_id' => (string) Str::uuid()])
            ->assertForbidden();
        $created = $this->postJson("{$this->base}/instructors", ['name' => 'Current instructor', 'request_id' => (string) Str::uuid()])
            ->assertCreated()->assertJsonPath('instructor.branch_ids', [$this->branches[0]])->json('instructor');
        $this->postJson("{$this->base}/instructors", ['name' => 'Forged instructor', 'branch_ids' => [$this->branches[1]], 'request_id' => (string) Str::uuid()])
            ->assertForbidden();
        $this->select($this->branches[1]);
        $this->getJson("{$this->base}/instructors/{$created['id']}")->assertNotFound();
        $this->select($this->branches[0]);
        $this->patchJson("{$this->base}/student-branch-settings", ['enabled' => true, 'revision' => 1])->assertOk();
        $shared = $this->postJson("{$this->base}/students", ['name' => 'All branch student', 'request_id' => (string) Str::uuid()])
            ->assertCreated()->assertJsonPath('student.branch_ids', [$this->branches[0]])->json('student');
        $this->select($this->branches[1]);
        $this->getJson("{$this->base}/students/{$shared['id']}")->assertOk()->assertJsonPath('students.0.branch_ids', [$this->branches[1]]);
    }

    public function test_group_and_session_sources_are_scoped_before_reads_previews_and_transactional_writes(): void
    {
        $north = $this->group($this->branches[0]);
        $south = $this->group($this->branches[1]);
        $session = $this->postJson("{$this->base}/groups/{$south['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => now('Africa/Cairo')->addDays(7)->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->select($this->branches[0]);
        $list = $this->getJson("{$this->base}/group-workspace")->assertOk()
            ->assertJsonCount(1, 'groups')->assertJsonCount(1, 'level_choices')->assertJsonPath('groups.0.id', $north['id']);
        $this->assertBudget($list);
        foreach (["groups/{$south['id']}", "groups/{$south['id']}/sessions", "groups/{$south['id']}/coverage",
            "groups/{$south['id']}/plan-applications/options", "groups/{$south['id']}/sessions/{$session['id']}/attendance",
            "groups/{$south['id']}/sessions/{$session['id']}/teaching"] as $path) {
            $this->getJson("{$this->base}/{$path}")->assertNotFound();
        }
        $this->postJson("{$this->base}/groups/{$south['id']}/sessions/preview", [
            'kind' => 'single', 'revision' => 2, 'start_at' => now('Africa/Cairo')->addDays(8)->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1,
        ])->assertNotFound();
        $this->patchJson("{$this->base}/groups/{$south['id']}/settings", [
            'revision' => 2, 'approved_price' => '10.00', 'completion_threshold' => null,
            'instructor_ids' => array_column($south['instructors'], 'id'),
        ])->assertNotFound();
    }

    public function test_study_lists_summary_waitlist_and_absence_rules_use_current_source(): void
    {
        $north = $this->group($this->branches[0]);
        $south = $this->group($this->branches[1]);
        $student = $this->postJson("{$this->base}/students", ['name' => 'Shared learner', 'branch_ids' => $this->branches,
            'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $enrollment = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")->assertOk()->json();
        $attempt = $this->postJson("{$this->base}/students/{$student['id']}/enrollments", [
            'group_id' => $south['id'], 'group_revision' => 1, 'currency_revision' => $enrollment['student']['currency_revision'],
            'version' => $enrollment['student']['version'], 'joined_on' => now('Africa/Cairo')->toDateString(),
            'discount' => '0.00', 'discount_reason' => null, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('attempt');
        $this->select($this->branches[0]);
        $this->getJson("{$this->base}/students/{$student['id']}/enrollments")->assertOk()
            ->assertJsonCount(0, 'attempts')->assertJsonCount(1, 'groups')->assertJsonPath('groups.0.id', $north['id']);
        $this->getJson("{$this->base}/students/{$student['id']}?tab=study")->assertOk()
            ->assertJsonCount(0, 'study.attempts')->assertJsonCount(0, 'summary.current_study');
        $this->getJson("{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/waitlist")->assertNotFound();
        $this->postJson("{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/waitlist", [
            'entered_on' => now('Africa/Cairo')->toDateString(), 'reason' => 'Wrong source waitlist', 'revision' => 1,
            'request_id' => (string) Str::uuid(),
        ])->assertNotFound();
        $this->postJson("{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/withdraw", [
            'withdrawn_on' => now('Africa/Cairo')->toDateString(), 'reason' => 'Wrong source', 'revision' => 1,
            'request_id' => (string) Str::uuid(),
        ])->assertNotFound();
        $absence = $this->getJson("{$this->base}/absence-review")->assertOk()->assertJsonCount(1, 'branches');
        foreach ($absence->json('options') as $option) {
            $this->assertSame($this->branches[0], $option['branch_id']);
        }
        $this->assertBudget($absence);
        $this->patchJson("{$this->base}/absence-rules/study_groups/{$south['id']}", ['mode' => 'total', 'limit' => 2, 'revision' => 1])
            ->assertNotFound();
        $this->getJson("{$this->base}/students/{$student['id']}/enrollments?purpose=transfer&attempt_id={$attempt['id']}")->assertNotFound();
        $this->select($this->branches[1]);
        $destinations = $this->getJson("{$this->base}/students/{$student['id']}/enrollments?purpose=transfer&attempt_id={$attempt['id']}")->assertOk()
            ->assertJsonCount(2, 'groups')->assertJsonCount(1, 'attempts');
        $this->assertBudget($destinations);
    }

    public function test_financial_account_stays_unified_but_new_payment_uses_selected_receiving_branch(): void
    {
        $student = $this->postJson("{$this->base}/students", ['name' => 'Shared account', 'branch_ids' => $this->branches,
            'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        foreach ($this->branches as $branchId) {
            $version = $this->getJson("{$this->base}/students/{$student['id']}/account")->assertOk()->json('account.version');
            $this->postJson("{$this->base}/students/{$student['id']}/payments", ['branch_id' => $branchId, 'method' => 'cash',
                'received_on' => now('Africa/Cairo')->toDateString(), 'amount' => '10.00', 'version' => $version,
                'request_id' => (string) Str::uuid()])->assertCreated();
        }
        $this->select($this->branches[0]);
        $account = $this->getJson("{$this->base}/students/{$student['id']}/account")->assertOk()
            ->assertJsonCount(2, 'payments')->assertJsonPath('account.received_total', '20.00')
            ->assertJsonCount(1, 'recordable_branches')->assertJsonPath('recordable_branches.0.id', $this->branches[0]);
        $this->assertBudget($account);
        $payment = ['method' => 'cash', 'received_on' => now('Africa/Cairo')->toDateString(), 'amount' => '5.00',
            'version' => $account->json('account.version'), 'request_id' => (string) Str::uuid()];
        $this->postJson("{$this->base}/students/{$student['id']}/payments", [...$payment, 'branch_id' => $this->branches[1]])->assertForbidden();
        $this->postJson("{$this->base}/students/{$student['id']}/payments", $payment)->assertCreated()->assertJsonPath('payment.branch_id', $this->branches[0]);
        $this->getJson("{$this->base}/students/{$student['id']}/account")->assertOk()->assertJsonPath('account.received_total', '25.00');
    }

    public function test_file_workspace_query_is_session_bound_and_copy_destinations_keep_independent_permissions(): void
    {
        $student = $this->postJson("{$this->base}/students", ['name' => 'North file', 'branch_ids' => [$this->branches[0]],
            'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $course = $this->postJson("{$this->base}/courses", ['name' => 'North content', 'branch_id' => $this->branches[0],
            'request_id' => (string) Str::uuid()])->assertCreated()->json('course');
        $north = $this->select($this->branches[0]);
        $destinations = $this->getJson("{$this->base}/courses/{$course['id']}/copy-destinations")->assertOk()
            ->assertJsonCount(1, 'branches')->assertJsonPath('branches.0.id', $this->branches[1]);
        $this->assertBudget($destinations);
        $south = $this->select($this->branches[1]);
        $this->getJson("{$this->base}/courses/{$course['id']}/copy-destinations")->assertNotFound();
        $this->withoutHeader('X-Courses-Workspace');
        $this->get("{$this->base}/students/{$student['id']}/barcode?workspace={$north}")->assertOk();
        $this->get("{$this->base}/students/{$student['id']}/barcode?workspace={$south}")->assertNotFound();
        $this->getJson("{$this->base}/students/{$student['id']}/barcode?workspace=".(string) Str::uuid())
            ->assertStatus(409)->assertJsonPath('code', 'workspace_expired');
    }

    public function test_staff_keeps_identity_permission_without_center_privileges_and_rechecks_revoked_write_grants(): void
    {
        $student = $this->postJson("{$this->base}/students", ['name' => 'Shared staff student', 'branch_ids' => $this->branches,
            'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $this->patchJson("{$this->base}/student-branch-settings", ['enabled' => true, 'revision' => 1])->assertOk();
        $this->center->run(function (): void {
            DB::table('center_grants')->where('user_id', $this->owner->id)->delete();
            foreach ([$this->branches[0] => ['registration', 'academic_admin'], $this->branches[1] => ['registration', 'student_identity']] as $branchId => $roles) {
                foreach ($roles as $role) {
                    DB::table('branch_grants')->insert(['user_id' => $this->owner->id, 'branch_id' => $branchId,
                        'role' => $role, 'created_at' => now(), 'updated_at' => now()]);
                }
            }
        });
        $north = $this->select($this->branches[0]);
        $profile = $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()
            ->assertJsonPath('permissions.can_manage_center', false)->assertJsonPath('students.0.can_read_identity', true)
            ->assertJsonPath('students.0.can_manage_identity', true)->assertJsonPath('students.0.branch_ids', [$this->branches[0]]);
        $this->assertBudget($profile);
        $created = $this->postJson("{$this->base}/students", ['name' => 'Scoped staff student', 'request_id' => (string) Str::uuid()])
            ->assertCreated()->assertJsonPath('student.branch_ids', [$this->branches[0]])->json('student');
        $this->select($this->branches[1]);
        $this->getJson("{$this->base}/students/{$created['id']}")->assertNotFound();
        $this->withHeader('X-Courses-Workspace', $north);
        $this->center->run(fn () => DB::table('branch_grants')->where('user_id', $this->owner->id)
            ->where('branch_id', $this->branches[0])->where('role', 'registration')->delete());
        $this->patchJson("{$this->base}/students/{$student['id']}", ['name' => 'Stale grant write', 'revision' => 1])->assertForbidden();
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.name', 'Shared staff student');
    }

    public function test_photo_and_attachment_writes_require_management_in_current_profile_source(): void
    {
        Storage::fake('local');
        $student = $this->postJson("{$this->base}/students", ['name' => 'Shared file source', 'branch_ids' => $this->branches,
            'request_id' => (string) Str::uuid()])->assertCreated()->json('student');
        $this->center->run(function (): void {
            DB::table('center_grants')->where('user_id', $this->owner->id)->delete();
            foreach ([$this->branches[0] => 'branch_viewer', $this->branches[1] => 'registration'] as $branchId => $role) {
                DB::table('branch_grants')->insert(['user_id' => $this->owner->id, 'branch_id' => $branchId,
                    'role' => $role, 'created_at' => now(), 'updated_at' => now()]);
            }
        });
        $this->select($this->branches[0]);
        $this->getJson("{$this->base}/students/{$student['id']}")->assertOk()->assertJsonPath('students.0.can_manage', false);
        $this->postJson("{$this->base}/students/{$student['id']}/photo", ['photo' => UploadedFile::fake()->image('photo.png'),
            'photo_revision' => 1, 'request_id' => (string) Str::uuid()])->assertNotFound();
        $this->postJson("{$this->base}/students/{$student['id']}/attachments", ['attachment_revision' => 1,
            'request_id' => (string) Str::uuid(), 'attachments' => [['title' => 'Current file', 'classification' => 'general',
                'file' => UploadedFile::fake()->image('attachment.png')]]])->assertNotFound();
    }

    private function assertBudget(TestResponse $response): void
    {
        $count = $response->headers->get('X-Courses-Query-Count');
        $this->assertMatchesRegularExpression('/^\d+$/', (string) $count);
        $this->assertLessThanOrEqual(6, (int) $count);
    }

    private function group(int $branchId): array
    {
        $course = $this->postJson("{$this->base}/courses", ['branch_id' => $branchId, 'name' => 'Course '.$branchId,
            'request_id' => (string) Str::uuid()])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", ['name' => 'Stage', 'request_id' => (string) Str::uuid()])
            ->assertCreated()->json('stage');
        $level = $this->postJson("{$this->base}/stages/{$stage['id']}/levels", ['name' => 'Level', 'request_id' => (string) Str::uuid(),
            'lectures' => [['number' => 1, 'content' => 'Content', 'planned_hours' => 2]]])->assertCreated()->json('level');
        $instructor = $this->postJson("{$this->base}/instructors", ['name' => 'Teacher '.$branchId, 'branch_ids' => [$branchId],
            'request_id' => (string) Str::uuid()])->assertCreated()->json('instructor');

        return $this->postJson("{$this->base}/groups", ['level_id' => $level['id'], 'plan_version_id' => $level['plan']['id'],
            'name' => 'Group '.$branchId, 'approved_price' => '0.00', 'instructor_ids' => [$instructor['id']],
            'request_id' => (string) Str::uuid()])->assertCreated()->json('group');
    }

    private function select(int $branchId): string
    {
        $id = $this->postJson("{$this->base}/workspaces", ['mode' => 'branch', 'branch_id' => $branchId])
            ->assertOk()->json('workspace.id');
        $this->withHeader('X-Courses-Workspace', $id);

        return $id;
    }
}
