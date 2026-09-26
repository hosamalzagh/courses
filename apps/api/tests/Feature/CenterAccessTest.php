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

class CenterAccessTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    public function test_suspended_membership_denies_existing_session_and_new_login_with_a_clear_state(): void
    {
        Mail::fake();
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')
            ->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha',
                'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
            ])->assertCreated();
        $alpha = Center::where('slug', 'alpha')->firstOrFail();
        $staff = User::factory()->create(['email_verified_at' => now(), 'password' => 'correct-horse-battery-staple']);
        $membership = CenterMembership::create(['user_id' => $staff->id, 'tenant_id' => $alpha->id, 'status' => 'active']);

        $this->actingAs($staff, 'web')->withSession(['center_id' => $alpha->id]);
        $this->getJson('http://alpha.courses.test/api/v1/center/user')->assertOk();
        $membership->update(['status' => 'suspended']);
        $denied = $this->getJson('http://alpha.courses.test/api/v1/center/user')
            ->assertForbidden()->assertJsonPath('code', 'membership_suspended')->assertDontSee($staff->email);
        $this->assertLessThanOrEqual(6, (int) $denied->headers->get('X-Courses-Query-Count'));
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', [
            'email' => $staff->email, 'password' => 'correct-horse-battery-staple',
        ])->assertForbidden()->assertJsonPath('code', 'membership_suspended');
    }

    public function test_login_rate_limit_does_not_block_a_separate_invitation_operation(): void
    {
        Mail::fake();
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')
            ->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha',
                'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
            ])->assertCreated();
        $this->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Beta', 'slug' => 'beta', 'subdomain' => 'beta',
            'plan' => 'starter', 'owner_email' => 'owner@beta.test',
        ])->assertCreated();
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/logout')->assertOk();
        $this->withServerVariables(['REMOTE_ADDR' => sprintf('198.18.%d.%d', random_int(1, 254), random_int(1, 254))]);

        for ($attempt = 0; $attempt < 5; $attempt++) {
            $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', [
                'email' => 'unknown@alpha.test', 'password' => 'incorrect-password',
            ])->assertUnprocessable();
        }
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', [
            'email' => 'unknown@alpha.test', 'password' => 'incorrect-password',
        ])->assertStatus(429);
        $this->postJson('http://beta.courses.test/api/v1/center/auth/login', [
            'email' => 'unknown@beta.test', 'password' => 'incorrect-password',
        ])->assertUnprocessable();
        $this->postJson('http://alpha.courses.test/api/v1/center/invitations/invalid', [
            'name' => 'No Invitation', 'password' => 'correct-horse-battery-staple',
            'password_confirmation' => 'correct-horse-battery-staple',
        ])->assertStatus(410);
    }

    public function test_branch_roles_and_center_host_boundaries_apply_on_every_request(): void
    {
        $platformOwner = User::factory()->platformOwner()->create();
        $this->actingAs($platformOwner, 'platform');
        foreach (['alpha', 'beta'] as $slug) {
            $this->withServerVariables(['HTTP_HOST' => 'courses.test'])
                ->postJson('/api/v1/platform/centers', [
                    'name' => ucfirst($slug), 'slug' => $slug, 'subdomain' => $slug,
                    'plan' => 'starter', 'owner_email' => "owner@{$slug}.test",
                ])->assertCreated();
        }

        $alpha = Center::where('slug', 'alpha')->firstOrFail();
        $staff = User::factory()->create(['email_verified_at' => now()]);
        CenterMembership::create(['user_id' => $staff->id, 'tenant_id' => $alpha->id, 'status' => 'active']);

        [$firstBranch, $secondBranch] = $alpha->run(function () use ($staff): array {
            $firstBranch = DB::table('branches')->insertGetId(['name' => 'First', 'slug' => 'first', 'created_at' => now(), 'updated_at' => now()]);
            $secondBranch = DB::table('branches')->insertGetId(['name' => 'Second', 'slug' => 'second', 'created_at' => now(), 'updated_at' => now()]);

            foreach (['branch_manager', 'branch_auditor'] as $role) {
                DB::table('branch_grants')->insert(['user_id' => $staff->id, 'branch_id' => $firstBranch, 'role' => $role, 'created_at' => now(), 'updated_at' => now()]);
            }
            DB::table('branch_grants')->insert(['user_id' => $staff->id, 'branch_id' => $secondBranch, 'role' => 'branch_viewer', 'created_at' => now(), 'updated_at' => now()]);

            return [$firstBranch, $secondBranch];
        });

        $this->actingAs($staff, 'web')->withSession(['center_id' => $alpha->id]);
        $this->patchJson("http://alpha.courses.test/api/v1/center/branches/{$firstBranch}", ['name' => 'First Updated'])
            ->assertOk();
        $this->getJson("http://alpha.courses.test/api/v1/center/branches/{$firstBranch}/audit")
            ->assertOk();
        $this->patchJson("http://alpha.courses.test/api/v1/center/branches/{$secondBranch}", ['name' => 'Denied'])
            ->assertForbidden();
        $this->getJson("http://alpha.courses.test/api/v1/center/branches/{$secondBranch}/audit")
            ->assertForbidden();
        $this->patchJson('http://alpha.courses.test/api/v1/center/settings', ['phone' => '123'])
            ->assertForbidden();
        $this->getJson('http://alpha.courses.test/api/v1/center/settings')
            ->assertForbidden();
        $this->getJson('http://alpha.courses.test/api/v1/center/user')
            ->assertOk()->assertJsonCount(2, 'user.permissions.branch_roles.'.$firstBranch);
        $this->getJson('http://beta.courses.test/api/v1/center/user?tenant_id='.$alpha->id)
            ->assertBadRequest();
        $this->getJson('http://unknown.courses.test/api/v1/center/user')
            ->assertNotFound();
        $alpha->update(['suspended' => true]);
        $this->getJson('http://alpha.courses.test/api/v1/center/user')
            ->assertStatus(423);

        $this->assertSame(2, Center::count());
    }

    public function test_landlord_stays_available_when_a_center_database_is_unavailable(): void
    {
        $platformOwner = User::factory()->platformOwner()->create();
        $this->actingAs($platformOwner, 'platform')->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha',
            'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
        ])->assertCreated();
        $center = Center::where('slug', 'alpha')->firstOrFail();
        $member = User::factory()->create(['email_verified_at' => now()]);
        CenterMembership::create(['user_id' => $member->id, 'tenant_id' => $center->id, 'status' => 'active']);
        DB::purge('tenant');
        DB::connection('provisioning')->statement('DROP DATABASE "'.$center->database()->getName().'" WITH (FORCE)');

        $this->actingAs($member, 'web')->withSession(['center_id' => $center->id]);
        $this->getJson('http://alpha.courses.test/api/v1/center/user')->assertStatus(503);
        $this->actingAs($platformOwner, 'platform')->getJson('http://courses.test/api/v1/platform/centers')->assertOk();
    }

    public function test_shared_identity_keeps_distinct_grants_and_rejects_client_selected_tenant_context(): void
    {
        Mail::fake();
        $owner = User::factory()->platformOwner()->create();
        $this->actingAs($owner, 'platform');
        foreach (['alpha', 'beta'] as $slug) {
            $this->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => ucfirst($slug), 'slug' => $slug, 'subdomain' => $slug,
                'plan' => 'starter', 'owner_email' => "owner@{$slug}.test",
            ])->assertCreated();
        }

        $alpha = Center::where('slug', 'alpha')->firstOrFail();
        $beta = Center::where('slug', 'beta')->firstOrFail();
        $shared = User::factory()->create(['email_verified_at' => now()]);
        foreach ([$alpha, $beta] as $center) {
            CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $shared->id, 'status' => 'active']);
        }
        $alphaBranch = $alpha->run(function () use ($shared): int {
            $id = DB::table('branches')->insertGetId(['name' => 'Alpha Secret', 'slug' => 'alpha-secret', 'created_at' => now(), 'updated_at' => now()]);
            DB::table('branch_grants')->insert(['user_id' => $shared->id, 'branch_id' => $id, 'role' => 'branch_viewer', 'created_at' => now(), 'updated_at' => now()]);

            return $id;
        });
        $betaBranch = $beta->run(function () use ($shared): int {
            $id = DB::table('branches')->insertGetId(['name' => 'Beta Secret', 'slug' => 'beta-secret', 'created_at' => now(), 'updated_at' => now()]);
            DB::table('branch_grants')->insert(['user_id' => $shared->id, 'branch_id' => $id, 'role' => 'branch_manager', 'created_at' => now(), 'updated_at' => now()]);

            return $id;
        });

        $this->actingAs($shared, 'web')->withSession(['center_id' => $alpha->id]);
        $alphaPage = $this->getJson('http://alpha.courses.test/api/v1/center/user')
            ->assertOk()->assertJsonPath('center.id', $alpha->id)
            ->assertJsonPath('branches.0.name', 'Alpha Secret')
            ->assertJsonPath('user.permissions.branch_roles.'.$alphaBranch.'.0', 'branch_viewer')
            ->assertDontSee('Beta Secret');
        $this->assertNotNull($alphaPage->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $alphaPage->headers->get('X-Courses-Query-Count'));
        $this->getJson('http://alpha.courses.test/api/v1/center/user?tenant_id='.$beta->id)->assertBadRequest();
        $this->getJson('http://alpha.courses.test/api/v1/center/user?database='.$beta->database()->getName())->assertBadRequest();
        $this->withHeaders(['X-Tenant-ID' => $beta->id, 'X-Database-Name' => $beta->database()->getName()])
            ->getJson('http://alpha.courses.test/api/v1/center/user')->assertBadRequest();
        $this->flushHeaders();
        $this->patchJson("http://alpha.courses.test/api/v1/center/branches/{$alphaBranch}", ['name' => 'Denied'])
            ->assertForbidden();
        $this->getJson('http://beta.courses.test/api/v1/center/user')->assertUnauthorized();
        $this->getJson('http://unknown.courses.test/api/v1/center/user')->assertNotFound();
        $this->withServerVariables([
            'HTTP_HOST' => 'unknown.courses.test', 'HTTP_X_FORWARDED_HOST' => 'alpha.courses.test',
        ])->getJson('/api/v1/center/user')->assertNotFound();

        $this->withSession(['center_id' => $beta->id]);
        $betaPage = $this->getJson('http://beta.courses.test/api/v1/center/user')->assertOk()
            ->assertJsonPath('center.id', $beta->id)
            ->assertJsonPath('branches.0.name', 'Beta Secret')
            ->assertJsonPath('user.permissions.branch_roles.'.$betaBranch.'.0', 'branch_manager')
            ->assertDontSee('Alpha Secret');
        $this->assertNotNull($betaPage->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $betaPage->headers->get('X-Courses-Query-Count'));
        $this->patchJson("http://beta.courses.test/api/v1/center/branches/{$betaBranch}", [
            'name' => 'Denied', 'tenant_id' => $alpha->id, 'database' => $alpha->database()->getName(),
        ])->assertBadRequest();
        $this->patchJson("http://beta.courses.test/api/v1/center/branches/{$betaBranch}", ['name' => 'Beta Updated'])->assertOk();
        $this->assertSame(2, CenterMembership::where('user_id', $shared->id)->count());
    }
}
