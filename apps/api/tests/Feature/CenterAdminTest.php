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

class CenterAdminTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    public function test_center_admin_manages_operations_without_gaining_platform_or_owner_rights(): void
    {
        Mail::fake();
        $this->actingAs(User::factory()->create(['platform_role' => 'platform_owner']))
            ->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha',
                'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
            ])->assertCreated();
        $center = Center::where('slug', 'alpha')->firstOrFail();
        $owner = User::factory()->create(['email_verified_at' => now()]);
        $admin = User::factory()->create(['email_verified_at' => now()]);
        $ownerMembership = CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $owner->id, 'status' => 'active']);
        $adminMembership = CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $admin->id, 'status' => 'active']);
        $center->run(function () use ($owner, $admin): void {
            DB::table('center_grants')->insert([
                ['user_id' => $owner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now()],
                ['user_id' => $admin->id, 'role' => 'center_admin', 'created_at' => now(), 'updated_at' => now()],
            ]);
        });

        $base = 'http://alpha.courses.test/api/v1/center';
        $this->actingAs($admin)->withSession(['center_id' => $center->id]);
        $this->putJson("{$base}/members/{$adminMembership->id}/grants", [
            'center_roles' => ['center_admin'], 'branch_roles' => [], 'platform_role' => 'platform_owner',
        ])->assertUnprocessable();
        $this->putJson("{$base}/members/{$adminMembership->id}/grants", [
            'center_roles' => ['center_owner'], 'branch_roles' => [],
        ])->assertForbidden();
        $this->postJson("{$base}/members/invitations", [
            'email' => 'new@alpha.test', 'platform_role' => 'platform_owner',
        ])->assertUnprocessable();
        $this->patchJson("{$base}/members/{$ownerMembership->id}/status", ['status' => 'suspended'])
            ->assertStatus(409)->assertJsonPath('code', 'last_active_owner');
        $this->getJson('http://courses.test/api/v1/platform/centers')->assertForbidden();
        $this->assertNull($admin->fresh()->platform_role);
        $this->assertSame('active', $ownerMembership->fresh()->status);

        $this->actingAs($owner)->withSession(['center_id' => $center->id]);
        $this->putJson("{$base}/members/{$ownerMembership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [],
        ])->assertStatus(409)->assertJsonPath('code', 'last_active_owner');
        $this->assertSame(1, $center->run(fn () => DB::table('center_grants')
            ->where('role', 'center_owner')->count()));

        $this->actingAs($admin)->withSession(['center_id' => $center->id]);
        $north = $this->postJson("{$base}/branches", ['name' => 'North', 'slug' => 'north'])
            ->assertCreated()->json('branch.id');
        $this->postJson("{$base}/branches", ['name' => 'South', 'slug' => 'south'])
            ->assertCreated();
        $this->patchJson("{$base}/branches/{$north}", ['name' => 'North Updated'])->assertOk();
        $this->patchJson("{$base}/settings", ['contact_email' => 'office@alpha.test'])
            ->assertOk()->assertJsonPath('settings.contact_email', 'office@alpha.test');
        $staff = User::factory()->create(['email_verified_at' => now()]);
        $staffMembership = CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $staff->id, 'status' => 'active']);
        $this->putJson("{$base}/members/{$staffMembership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [(string) $north => ['branch_viewer']],
        ])->assertOk();
        $this->putJson("{$base}/members/{$staffMembership->id}/grants", [
            'center_roles' => ['center_admin'], 'branch_roles' => [],
        ])->assertForbidden();
        $this->patchJson("{$base}/members/{$staffMembership->id}/status", ['status' => 'suspended'])
            ->assertOk();
        $this->assertSame('suspended', $staffMembership->fresh()->status);

        $userPage = $this->getJson("{$base}/user")->assertOk()->assertJsonCount(2, 'branches')
            ->assertJsonPath('permissions.center_roles.0', 'center_admin');
        $this->assertQueryBudget($userPage);
        $settingsPage = $this->getJson("{$base}/user?include=settings")->assertOk()
            ->assertJsonPath('settings.contact_email', 'office@alpha.test');
        $this->assertQueryBudget($settingsPage);
        $membersPage = $this->getJson("{$base}/member-workspace")->assertOk()
            ->assertJsonCount(3, 'members');
        $this->assertQueryBudget($membersPage);
        $auditPage = $this->getJson("{$base}/user?include=audit")->assertOk()
            ->assertJsonFragment(['event' => 'center.settings_updated'])
            ->assertJsonFragment(['event' => 'member.status_changed']);
        $this->assertQueryBudget($auditPage);
        $this->assertSame(1, collect($auditPage->json('audit_entries'))
            ->where('event', 'member.status_changed')->count());

        $this->actingAs($owner)->withSession(['center_id' => $center->id]);
        $this->putJson("{$base}/members/{$staffMembership->id}/grants", [
            'center_roles' => ['center_owner'], 'branch_roles' => [(string) $north => ['branch_viewer']],
        ])->assertOk();
        $ownerAudit = $this->getJson("{$base}/audit")->assertOk()->json('entries');
        $this->assertTrue(collect($ownerAudit)->where('event', 'member.grants_changed')
            ->contains(fn ($entry) => in_array('center_owner', json_decode($entry['details'], true)['center_roles'], true)));
    }

    private function assertQueryBudget(TestResponse $response): void
    {
        $count = $response->headers->get('X-Courses-Query-Count');
        $this->assertNotNull($count);
        $this->assertMatchesRegularExpression('/^\d+$/', $count);
        $this->assertLessThanOrEqual(6, (int) $count);
    }
}
