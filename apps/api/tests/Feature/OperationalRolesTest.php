<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class OperationalRolesTest extends TestCase
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
        foreach ([$this->owner, $this->staff] as $user) {
            $membership = CenterMembership::create(['tenant_id' => $this->center->id, 'user_id' => $user->id, 'status' => 'active']);
            if ($user->is($this->staff)) {
                $this->membership = $membership;
            }
        }
        $this->center->run(fn () => DB::table('center_grants')->insert([
            'user_id' => $this->owner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
        ]));
        $this->asUser($this->owner);
        $this->north = $this->postJson("{$this->base}/branches", ['name' => 'North', 'slug' => 'north'])->assertCreated()->json('branch.id');
        $this->south = $this->postJson("{$this->base}/branches", ['name' => 'South', 'slug' => 'south'])->assertCreated()->json('branch.id');
    }

    public function test_combined_operational_roles_are_persisted_and_do_not_grant_branch_editing_or_sensitive_actions(): void
    {
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [
                $this->north => ['registration', 'attendance'], $this->south => ['accounting'],
            ],
        ])->assertOk();
        $this->asUser($this->staff);
        $response = $this->getJson("{$this->base}/user")->assertOk()->assertJsonCount(2, 'branches');
        $permissions = $response->json('user.permissions');
        $this->assertContains('enrollment.manage', $permissions['branch_actions'][$this->north]);
        $this->assertContains('attendance.record', $permissions['branch_actions'][$this->north]);
        $this->assertNotContains('attendance.correct', $permissions['branch_actions'][$this->north]);
        $this->assertNotContains('fees.discount', $permissions['branch_actions'][$this->north]);
        $this->assertContains('payments.record', $permissions['branch_actions'][$this->south]);
        $this->assertNotContains('finance.approve', $permissions['branch_actions'][$this->south]);
        $this->assertNotContains('students.search_center', $permissions['branch_actions'][$this->north]);
        $this->patchJson("{$this->base}/branches/{$this->north}", ['name' => 'Denied'])->assertForbidden();
        $this->getJson("{$this->base}/branches/{$this->north}")->assertOk();
        $this->assertLessThanOrEqual(6, (int) $response->headers->get('X-Courses-Query-Count'));
    }

    public function test_only_owner_can_change_financial_approval(): void
    {
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", [
            'center_roles' => ['center_admin'], 'branch_roles' => [],
        ])->assertOk();
        $other = User::factory()->create();
        $target = CenterMembership::create(['tenant_id' => $this->center->id, 'user_id' => $other->id, 'status' => 'active']);
        $this->asUser($this->staff);
        $this->putJson("{$this->base}/members/{$target->id}/grants", [
            'center_roles' => [], 'branch_roles' => [$this->north => ['accounting', 'financial_approval']],
        ])->assertForbidden();
    }

    public function test_stale_assignment_is_rejected_and_duplicate_submission_does_not_duplicate_audit(): void
    {
        $member = collect($this->getJson("{$this->base}/member-workspace")->assertOk()->json('members'))
            ->firstWhere('id', $this->membership->id);
        $payload = ['center_roles' => [], 'branch_roles' => [$this->north => ['attendance']], 'grant_revision' => $member['grant_revision']];
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", $payload)->assertOk();
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", $payload)->assertOk();
        $payload['branch_roles'][$this->north] = ['registration'];
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", $payload)
            ->assertConflict()->assertJsonPath('code', 'grants_changed');
        $events = collect($this->getJson("{$this->base}/audit")->assertOk()->json('entries'))
            ->where('event', 'member.grants_changed')->values();
        $this->assertCount(1, $events);
        $details = json_decode($events[0]['details'], true);
        $this->assertSame([], $details['branch_roles_before']);
        $this->assertSame(['attendance'], $details['branch_roles_after'][$this->north]);
        $this->assertSame('الحضور', $details['role_labels']['attendance']);
        $this->assertSame($this->owner->id, $events[0]['actor_id']);
    }

    public function test_branch_scoped_save_preserves_other_assignments_and_revocation_applies_immediately(): void
    {
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [$this->north => ['registration'], $this->south => ['accounting', 'financial_approval']],
        ])->assertOk();
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [$this->north => ['attendance', 'fee_discount']], 'branch_scope' => [$this->north],
        ])->assertOk();
        $this->asUser($this->staff);
        $permissions = $this->getJson("{$this->base}/user")->assertOk()->json('user.permissions.branch_actions');
        $this->assertContains('finance.approve', $permissions[$this->south]);
        $this->assertContains('fees.discount', $permissions[$this->north]);
        $this->assertNotContains('enrollment.manage', $permissions[$this->north]);
        $this->asUser($this->owner);
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [], 'branch_scope' => [$this->north],
        ])->assertOk();
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/branches/{$this->north}")->assertForbidden();
        $this->getJson("{$this->base}/branches/{$this->south}")->assertOk();
        $this->asUser($this->owner);
        $this->patchJson("{$this->base}/members/{$this->membership->id}/status", ['status' => 'suspended'])->assertOk();
        $this->asUser($this->staff);
        $this->getJson("{$this->base}/branches/{$this->south}")->assertForbidden();
    }

    public function test_workspace_is_bounded_without_loading_hidden_branch_assignments_and_query_count_is_flat(): void
    {
        $this->center->run(function (): void {
            for ($number = 1; $number <= 55; $number++) {
                DB::table('branches')->insert(['name' => sprintf(($number % 3 === 0 ? 'école' : ($number % 2 === 0 ? 'الفرع' : 'Branch')).' %02d', $number), 'slug' => "branch-{$number}"]);
            }
        });
        for ($number = 1; $number <= 55; $number++) {
            $user = User::factory()->create();
            CenterMembership::create(['tenant_id' => $this->center->id, 'user_id' => $user->id, 'status' => 'active']);
        }
        $first = $this->getJson("{$this->base}/member-workspace")->assertOk()
            ->assertJsonCount(50, 'members')->assertJsonCount(50, 'branches')
            ->assertJsonPath('pagination.members.has_more', true)->assertJsonPath('pagination.branches.has_more', true);
        $next = $this->getJson("{$this->base}/member-workspace?members_page=2&branches_page=2")->assertOk()
            ->assertJsonCount(7, 'members')->assertJsonCount(7, 'branches')
            ->assertJsonPath('pagination.members.has_more', false)->assertJsonPath('pagination.branches.has_more', false);
        $this->assertLessThanOrEqual(6, (int) $first->headers->get('X-Courses-Query-Count'));
        $this->assertSame($first->headers->get('X-Courses-Query-Count'), $next->headers->get('X-Courses-Query-Count'));
        $member = collect($first->json('members'))->firstWhere('id', $this->membership->id);
        $scope = array_column($first->json('branches'), 'id');
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [$scope[0] => ['academic_admin']],
            'branch_scope' => $scope, 'grant_revision' => $member['grant_revision'],
        ])->assertOk();
        $reloaded = $this->getJson("{$this->base}/member-workspace")->assertOk();
        $staff = collect($reloaded->json('members'))->firstWhere('id', $this->membership->id);
        $this->assertSame(['academic_admin'], $staff['branch_roles'][$scope[0]]);
        $this->assertSame([], array_intersect($scope, array_column($next->json('branches'), 'id')));
    }

    private function asUser(User $user): void
    {
        $this->actingAs($user, 'web')->withSession(['center_id' => $this->center->id]);
    }
}
