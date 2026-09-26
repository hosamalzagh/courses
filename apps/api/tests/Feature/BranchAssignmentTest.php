<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Testing\TestResponse;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class BranchAssignmentTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    public function test_two_managers_share_a_branch_while_one_manages_a_second_branch(): void
    {
        Mail::fake();
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')
            ->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha',
                'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
            ])->assertCreated();
        $center = Center::where('slug', 'alpha')->firstOrFail();
        $owner = User::factory()->create(['email_verified_at' => now()]);
        $firstManager = User::factory()->create(['email_verified_at' => now()]);
        $secondManager = User::factory()->create(['email_verified_at' => now()]);
        foreach ([$owner, $firstManager, $secondManager] as $user) {
            CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $user->id, 'status' => 'active']);
        }
        $center->run(fn () => DB::table('center_grants')->insert([
            'user_id' => $owner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
        ]));

        $this->actingAs($owner, 'web')->withSession(['center_id' => $center->id]);
        $base = 'http://alpha.courses.test/api/v1/center';
        $north = $this->postJson("{$base}/branches", ['name' => 'North', 'slug' => 'north'])
            ->assertCreated()->json('branch.id');
        $south = $this->postJson("{$base}/branches", ['name' => 'South', 'slug' => 'south'])
            ->assertCreated()->json('branch.id');
        $east = $this->postJson("{$base}/branches", ['name' => 'East', 'slug' => 'east'])
            ->assertCreated()->json('branch.id');
        $firstMembership = CenterMembership::where('tenant_id', $center->id)
            ->where('user_id', $firstManager->id)->firstOrFail();
        $secondMembership = CenterMembership::where('tenant_id', $center->id)
            ->where('user_id', $secondManager->id)->firstOrFail();

        $this->putJson("{$base}/members/{$firstMembership->id}/grants", [
            'center_roles' => [],
            'branch_roles' => [
                (string) $north => ['branch_manager'],
                (string) $south => ['branch_manager'],
            ],
        ])->assertOk();
        $this->putJson("{$base}/members/{$secondMembership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [(string) $north => ['branch_manager']],
        ])->assertOk();

        $this->assertSame(3, $center->run(fn () => DB::table('branch_grants')
            ->where('role', 'branch_manager')->count()));
        $this->assertSame(2, $center->run(fn () => DB::table('branch_grants')
            ->where('branch_id', $north)->where('role', 'branch_manager')->count()));
        $this->assertSame(2, $center->run(fn () => DB::table('center_audit_logs')
            ->where('event', 'member.grants_changed')->count()));

        $ownerPage = $this->getJson("{$base}/user")->assertOk()->assertJsonCount(3, 'branches');
        $this->assertQueryBudget($ownerPage);

        $this->actingAs($firstManager, 'web')->withSession(['center_id' => $center->id]);
        foreach (['user', 'branches'] as $path) {
            $page = $this->getJson("{$base}/{$path}")->assertOk()->assertJsonCount(2, 'branches');
            $this->assertQueryBudget($page);
        }
        foreach ([$north, $south] as $branchId) {
            $page = $this->getJson("{$base}/branches/{$branchId}")->assertOk();
            $this->assertQueryBudget($page);
        }
        $this->getJson("{$base}/branches/{$east}")->assertForbidden();
        $this->patchJson("{$base}/branches/{$east}", ['name' => 'Denied'])->assertForbidden();
        $this->patchJson("{$base}/branches/{$south}", ['name' => 'South Updated'])->assertOk();

        $this->actingAs($secondManager, 'web')->withSession(['center_id' => $center->id]);
        $page = $this->getJson("{$base}/user")->assertOk()->assertJsonCount(1, 'branches')
            ->assertJsonPath('branches.0.name', 'North');
        $this->assertQueryBudget($page);
        $this->getJson("{$base}/branches/{$south}")->assertForbidden();
        $this->patchJson("{$base}/branches/{$south}", ['name' => 'Denied'])->assertForbidden();
        $this->patchJson("{$base}/branches/{$north}", ['name' => 'North Updated'])->assertOk();

        $events = $center->run(fn () => DB::table('center_audit_logs')
            ->where('event', 'branch.updated')->orderBy('id')->get(['actor_id', 'branch_id']));
        $this->assertSame([$firstManager->id, $secondManager->id], $events->pluck('actor_id')->all());
        $this->assertSame([$south, $north], $events->pluck('branch_id')->all());
    }

    private function assertQueryBudget(TestResponse $response): void
    {
        $count = $response->headers->get('X-Courses-Query-Count');
        $this->assertNotNull($count);
        $this->assertMatchesRegularExpression('/^\d+$/', $count);
        $this->assertLessThanOrEqual(6, (int) $count);
    }
}
