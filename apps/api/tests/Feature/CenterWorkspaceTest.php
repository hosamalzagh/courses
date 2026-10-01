<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PragmaRX\Google2FA\Google2FA;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class CenterWorkspaceTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    private Center $center;

    private User $staff;

    private array $branches;

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
        $this->staff = User::factory()->create(['email_verified_at' => now(), 'password' => 'correct-horse-battery-staple']);
        CenterMembership::create(['user_id' => $this->staff->id, 'tenant_id' => $this->center->id, 'status' => 'active']);
        $this->branches = $this->center->run(function (): array {
            $ids = [];
            foreach (['North', 'South', 'Extra'] as $name) {
                $id = DB::table('branches')->insertGetId(['name' => $name, 'slug' => strtolower($name), 'created_at' => now(), 'updated_at' => now()]);
                DB::table('branch_grants')->insert(['user_id' => $this->staff->id, 'branch_id' => $id,
                    'role' => $name === 'Extra' ? 'fee_discount' : 'academic_admin', 'created_at' => now(), 'updated_at' => now()]);
                $ids[] = $id;
            }

            return $ids;
        });
        $this->actingAs($this->staff, 'web')->withSession(['center_id' => $this->center->id]);
    }

    public function test_preexisting_authenticated_session_requires_selection_before_protected_reads_or_writes(): void
    {
        $this->assertPreexistingSessionRequiresSelection(false);
    }

    public function test_preexisting_owner_session_requires_selection_before_implicit_center_access(): void
    {
        $this->assertPreexistingSessionRequiresSelection(true);
    }

    private function assertPreexistingSessionRequiresSelection(bool $manager): void
    {
        if ($manager) {
            $this->center->run(fn () => DB::table('center_grants')->insert([
                'user_id' => $this->staff->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
            ]));
        }
        // This session predates workspace support: only its center and web identity exist.
        Auth::guard('web')->login($this->staff);
        $this->assertTrue(session()->has(Auth::guard('web')->getName()));
        Auth::forgetGuards();
        $this->assertFalse(session()->has('initial_workspace'));
        $this->assertFalse(session()->has('workspace_required'));
        foreach (['user', 'curriculum-workspace'] as $path) {
            $this->getJson('http://alpha.courses.test/api/v1/center/'.$path)
                ->assertStatus(409)->assertJsonPath('code', 'workspace_required');
        }
        $payload = ['request_id' => (string) Str::uuid(), 'branch_id' => $this->branches[1], 'name' => 'Unselected old session'];
        $this->postJson('http://alpha.courses.test/api/v1/center/courses', $payload)
            ->assertStatus(409)->assertJsonPath('code', 'workspace_required');
        $this->center->run(fn () => $this->assertSame(0, DB::table('courses')->count()));
        $this->getJson('http://alpha.courses.test/api/v1/center/workspaces')->assertOk()->assertJsonCount($manager ? 3 : 2, 'branches');
        $workspace = $this->postJson('http://alpha.courses.test/api/v1/center/workspaces', [
            'mode' => 'branch', 'branch_id' => $this->branches[0],
        ])->assertOk()->json('workspace.id');
        $this->withHeader('X-Courses-Workspace', $workspace)
            ->getJson('http://alpha.courses.test/api/v1/center/curriculum-workspace')->assertOk()
            ->assertJsonPath('workspace.branch.id', $this->branches[0]);
        $this->postJson('http://alpha.courses.test/api/v1/center/courses', $payload)->assertForbidden();
        $this->postJson('http://alpha.courses.test/api/v1/center/courses', [
            ...$payload, 'branch_id' => $this->branches[0],
        ])->assertCreated();
    }

    public function test_selected_workspace_scopes_course_reads_and_transactional_writes_without_changing_raw_grants(): void
    {
        $selection = $this->postJson('http://alpha.courses.test/api/v1/center/workspaces', [
            'mode' => 'branch', 'branch_id' => $this->branches[0], 'return_to' => '/admin/curriculum?course_id=old',
        ])->assertOk();
        $workspace = $selection->json('workspace.id');
        $this->assertSame('/admin/curriculum?workspace='.$workspace, $selection->json('destination'));
        $this->withHeader('X-Courses-Workspace', $workspace);
        $this->postJson('http://alpha.courses.test/api/v1/center/courses', [
            'request_id' => (string) Str::uuid(), 'branch_id' => $this->branches[1], 'name' => 'Wrong branch',
        ])->assertForbidden();
        $created = $this->postJson('http://alpha.courses.test/api/v1/center/courses', [
            'request_id' => (string) Str::uuid(), 'branch_id' => $this->branches[0], 'name' => 'North course',
        ])->assertCreated();
        $read = $this->getJson('http://alpha.courses.test/api/v1/center/curriculum-workspace')->assertOk()
            ->assertJsonCount(1, 'courses')->assertJsonPath('workspace.branch.name', 'North');
        $this->assertContains('curriculum.manage', $read->json('permissions.branch_actions.'.$this->branches[1]));
        $this->assertMatchesRegularExpression('/^\\d+$/', $read->headers->get('X-Courses-Query-Count') ?? '');
        $this->assertLessThanOrEqual(6, (int) $read->headers->get('X-Courses-Query-Count'));
        $south = $this->postJson('http://alpha.courses.test/api/v1/center/workspaces', [
            'mode' => 'branch', 'branch_id' => $this->branches[1],
        ])->assertOk()->json('workspace.id');
        $this->withHeader('X-Courses-Workspace', $south)
            ->getJson('http://alpha.courses.test/api/v1/center/curriculum-workspace?course_id='.$created->json('course.id'))->assertNotFound();
        $this->withHeader('X-Courses-Workspace', $workspace)
            ->getJson('http://alpha.courses.test/api/v1/center/curriculum-workspace')->assertOk()->assertJsonCount(1, 'courses');
    }

    public function test_picker_only_offers_readable_branches_and_rejects_forged_modes_and_contexts(): void
    {
        $response = $this->getJson('http://alpha.courses.test/api/v1/center/workspaces')->assertOk()->assertJsonCount(2, 'branches');
        $this->assertMatchesRegularExpression('/^\\d+$/', $response->headers->get('X-Courses-Query-Count') ?? '');
        $this->assertLessThanOrEqual(6, (int) $response->headers->get('X-Courses-Query-Count'));
        $this->postJson('http://alpha.courses.test/api/v1/center/workspaces', ['mode' => 'branch', 'branch_id' => $this->branches[2]])->assertForbidden();
        $this->postJson('http://alpha.courses.test/api/v1/center/workspaces', ['mode' => 'center'])->assertForbidden();
        $this->withHeader('X-Courses-Workspace', (string) Str::uuid())
            ->getJson('http://alpha.courses.test/api/v1/center/curriculum-workspace')->assertStatus(409)->assertJsonPath('code', 'workspace_expired');
    }

    public function test_revoked_branch_and_suspended_membership_apply_on_the_next_request(): void
    {
        $id = $this->postJson('http://alpha.courses.test/api/v1/center/workspaces', ['mode' => 'branch', 'branch_id' => $this->branches[0]])->assertOk()->json('workspace.id');
        $this->center->run(fn () => DB::table('branch_grants')->where('user_id', $this->staff->id)->where('branch_id', $this->branches[0])->delete());
        $this->withHeader('X-Courses-Workspace', $id)->getJson('http://alpha.courses.test/api/v1/center/user')->assertStatus(409)->assertJsonPath('code', 'workspace_expired');
        $this->getJson('http://alpha.courses.test/api/v1/center/workspaces')->assertOk()->assertJsonCount(1, 'branches');
        CenterMembership::where('user_id', $this->staff->id)->update(['status' => 'suspended']);
        $this->getJson('http://alpha.courses.test/api/v1/center/workspaces')->assertForbidden()->assertJsonPath('code', 'membership_suspended');
    }

    public function test_password_login_single_multiple_and_zero_branch_states_and_old_session_rejection(): void
    {
        Auth::guard('web')->logout();
        Auth::guard('web')->logout();
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', ['email' => $this->staff->email, 'password' => 'correct-horse-battery-staple'])
            ->assertOk()->assertJsonPath('destination', '/admin/workspaces');
        $this->getJson('http://alpha.courses.test/api/v1/center/user')->assertStatus(409)->assertJsonPath('code', 'workspace_required');
        $old = $this->postJson('http://alpha.courses.test/api/v1/center/workspaces', ['mode' => 'branch', 'branch_id' => $this->branches[0]])->assertOk()->json('workspace.id');
        $this->center->run(fn () => DB::table('branch_grants')->where('user_id', $this->staff->id)->where('branch_id', $this->branches[1])->delete());
        Auth::guard('web')->logout();
        $login = $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', ['email' => $this->staff->email, 'password' => 'correct-horse-battery-staple'])->assertOk();
        parse_str(parse_url($login->json('destination'), PHP_URL_QUERY), $params);
        $this->assertNotSame($old, $params['workspace']);
        $this->getJson('http://alpha.courses.test/api/v1/center/curriculum-workspace')->assertOk()->assertJsonPath('workspace.branch.id', $this->branches[0])->assertJsonPath('workspace_can_switch', false);
        $this->withHeader('X-Courses-Workspace', $old)->getJson('http://alpha.courses.test/api/v1/center/user')->assertStatus(409);
        $this->center->run(fn () => DB::table('branch_grants')->where('user_id', $this->staff->id)->delete());
        Auth::guard('web')->logout();
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', ['email' => $this->staff->email, 'password' => 'correct-horse-battery-staple'])
            ->assertOk()->assertJsonPath('destination', '/admin/workspaces');
        $this->getJson('http://alpha.courses.test/api/v1/center/workspaces')->assertOk()->assertJsonCount(0, 'branches');
    }

    public function test_mfa_selects_from_current_rights_only_after_successful_challenge(): void
    {
        Auth::guard('web')->logout();
        $totp = app(Google2FA::class);
        $secret = $totp->generateSecretKey();
        $this->staff->forceFill(['app_authentication_secret' => $secret])->save();
        Auth::guard('web')->logout();
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', ['email' => $this->staff->email, 'password' => 'correct-horse-battery-staple'])
            ->assertStatus(202)->assertJsonPath('status', 'mfa_challenge_required');
        $this->getJson('http://alpha.courses.test/api/v1/center/workspaces')->assertUnauthorized();
        $this->center->run(fn () => DB::table('branch_grants')->where('user_id', $this->staff->id)->where('branch_id', $this->branches[1])->delete());
        $login = $this->postJson('http://alpha.courses.test/api/v1/center/auth/mfa/challenge', ['code' => $totp->getCurrentOtp($secret)])->assertOk();
        $this->assertStringStartsWith('/admin?workspace=', $login->json('destination'));
        $this->getJson('http://alpha.courses.test/api/v1/center/curriculum-workspace')->assertOk()->assertJsonPath('workspace.branch.id', $this->branches[0]);
    }

    public function test_manager_keeps_original_role_and_center_view_but_branch_workspace_restricts_source(): void
    {
        $this->center->run(fn () => DB::table('center_grants')->insert(['user_id' => $this->staff->id, 'role' => 'center_admin', 'created_at' => now(), 'updated_at' => now()]));
        $id = $this->postJson('http://alpha.courses.test/api/v1/center/workspaces', ['mode' => 'branch', 'branch_id' => $this->branches[0]])->assertOk()->json('workspace.id');
        $this->withHeader('X-Courses-Workspace', $id)->getJson('http://alpha.courses.test/api/v1/center/curriculum-workspace')->assertOk()
            ->assertJsonPath('permissions.can_manage_center', true)->assertJsonCount(1, 'branches');
        $center = $this->postJson('http://alpha.courses.test/api/v1/center/workspaces', ['mode' => 'center'])->assertOk()->json('workspace.id');
        $this->withHeader('X-Courses-Workspace', $center)->getJson('http://alpha.courses.test/api/v1/center/curriculum-workspace')->assertOk()->assertJsonCount(3, 'branches');
        $this->postJson('http://alpha.courses.test/api/v1/center/courses', ['request_id' => (string) Str::uuid(), 'branch_id' => $this->branches[1], 'name' => 'South course'])->assertCreated();
        $this->withHeader('X-Courses-Workspace', $id)->getJson('http://alpha.courses.test/api/v1/center/curriculum-workspace')->assertOk()->assertJsonCount(0, 'courses');
    }

    public function test_workspace_cannot_be_reused_by_another_identity_and_branch_options_are_bounded(): void
    {
        $id = $this->postJson('http://alpha.courses.test/api/v1/center/workspaces', ['mode' => 'branch', 'branch_id' => $this->branches[0]])->assertOk()->json('workspace.id');
        $other = User::factory()->create(['email_verified_at' => now()]);
        CenterMembership::create(['tenant_id' => $this->center->id, 'user_id' => $other->id, 'status' => 'active']);
        $this->actingAs($other, 'web')->withHeader('X-Courses-Workspace', $id)->getJson('http://alpha.courses.test/api/v1/center/curriculum-workspace')->assertStatus(409);
        $this->actingAs($this->staff, 'web');
        $this->center->run(function (): void {
            DB::table('center_grants')->insert(['user_id' => $this->staff->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now()]);
            for ($i = 1; $i <= 51; $i++) {
                DB::table('branches')->insert(['name' => 'Branch '.$i, 'slug' => 'branch-'.$i, 'created_at' => now(), 'updated_at' => now()]);
            }
        });
        $this->getJson('http://alpha.courses.test/api/v1/center/workspaces')->assertOk()->assertJsonCount(50, 'branches')->assertJsonPath('pagination.has_more', true);
        $this->getJson('http://alpha.courses.test/api/v1/center/workspaces?page=2')->assertOk()->assertJsonCount(4, 'branches')->assertJsonPath('pagination.has_more', false);
    }

    public function test_manager_with_no_branches_enters_first_branch_setup_and_has_no_redundant_switch(): void
    {
        Auth::guard('web')->logout();
        $this->center->run(function (): void {
            DB::table('branch_grants')->delete();
            DB::table('branches')->delete();
            DB::table('center_grants')->insert(['user_id' => $this->staff->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now()]);
        });
        Auth::guard('web')->logout();
        $login = $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', ['email' => $this->staff->email, 'password' => 'correct-horse-battery-staple'])->assertOk();
        $this->assertStringStartsWith('/admin/settings?workspace=', $login->json('destination'));
        $this->assertStringEndsWith('&tab=branches', $login->json('destination'));
        $this->getJson('http://alpha.courses.test/api/v1/center/user')->assertOk()->assertJsonPath('workspace.mode', 'center')->assertJsonPath('workspace_can_switch', false);
    }
}
