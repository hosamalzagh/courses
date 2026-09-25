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

    public function test_login_rate_limit_does_not_block_a_separate_invitation_operation(): void
    {
        Mail::fake();
        $this->actingAs(User::factory()->create(['platform_role' => 'platform_owner']))
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
        $platformOwner = User::factory()->create(['platform_role' => 'platform_owner']);
        $this->actingAs($platformOwner);
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

        $this->actingAs($staff)->withSession(['center_id' => $alpha->id]);
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
            ->assertUnauthorized();
        $this->getJson('http://unknown.courses.test/api/v1/center/user')
            ->assertNotFound();
        $alpha->update(['suspended' => true]);
        $this->getJson('http://alpha.courses.test/api/v1/center/user')
            ->assertStatus(423);

        $this->assertSame(2, Center::count());
    }

    public function test_landlord_stays_available_when_a_center_database_is_unavailable(): void
    {
        $platformOwner = User::factory()->create(['platform_role' => 'platform_owner']);
        $this->actingAs($platformOwner)->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha',
            'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
        ])->assertCreated();
        $center = Center::where('slug', 'alpha')->firstOrFail();
        $member = User::factory()->create(['email_verified_at' => now()]);
        CenterMembership::create(['user_id' => $member->id, 'tenant_id' => $center->id, 'status' => 'active']);
        DB::purge('tenant');
        DB::connection('provisioning')->statement('DROP DATABASE "'.$center->database()->getName().'" WITH (FORCE)');

        $this->actingAs($member)->withSession(['center_id' => $center->id]);
        $this->getJson('http://alpha.courses.test/api/v1/center/user')->assertStatus(503);
        $this->actingAs($platformOwner)->getJson('http://courses.test/api/v1/platform/centers')->assertOk();
    }
}
