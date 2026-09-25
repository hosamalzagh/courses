<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use RuntimeException;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class CenterMemberManagementTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    public function test_member_grants_are_scoped_to_center_and_apply_on_the_next_request(): void
    {
        Mail::fake();
        $platformOwner = User::factory()->create(['platform_role' => 'platform_owner']);
        $this->actingAs($platformOwner);
        foreach (['alpha', 'beta'] as $slug) {
            $this->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => ucfirst($slug), 'slug' => $slug, 'subdomain' => $slug,
                'plan' => 'starter', 'owner_email' => "owner@{$slug}.test",
            ])->assertCreated();
        }
        $alpha = Center::where('slug', 'alpha')->firstOrFail();
        $beta = Center::where('slug', 'beta')->firstOrFail();
        $owner = User::factory()->create(['email_verified_at' => now()]);
        $staff = User::factory()->create(['email_verified_at' => now()]);
        $ownerMembership = CenterMembership::create(['tenant_id' => $alpha->id, 'user_id' => $owner->id, 'status' => 'active']);
        $staffMembership = CenterMembership::create(['tenant_id' => $alpha->id, 'user_id' => $staff->id, 'status' => 'active']);
        $alpha->run(function () use ($owner): void {
            DB::table('center_grants')->insert([
                'user_id' => $owner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
            ]);
        });
        $branchId = $alpha->run(fn () => DB::table('branches')->insertGetId([
            'name' => 'North', 'slug' => 'north', 'created_at' => now(), 'updated_at' => now(),
        ]));
        $alpha->run(fn () => DB::table('branches')->insert([
            'name' => 'South', 'slug' => 'south', 'created_at' => now(), 'updated_at' => now(),
        ]));

        $this->actingAs($owner)->withSession(['center_id' => $alpha->id]);
        $this->patchJson("http://alpha.courses.test/api/v1/center/members/{$ownerMembership->id}/status", ['status' => 'suspended'])
            ->assertStatus(409);
        $this->putJson("http://alpha.courses.test/api/v1/center/members/{$staffMembership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [(string) $branchId => ['branch_viewer', 'branch_auditor']],
        ])->assertOk();
        $this->postJson('http://alpha.courses.test/api/v1/center/members/invitations', ['email' => 'new@alpha.test'])
            ->assertCreated();
        $this->getJson('http://alpha.courses.test/api/v1/center/members')->assertOk()
            ->assertJsonCount(2, 'invitations');
        $workspace = $this->getJson('http://alpha.courses.test/api/v1/center/member-workspace')
            ->assertOk()->assertJsonPath('branches.0.name', 'North')->assertJsonCount(2, 'branches')->assertJsonCount(2, 'members')
            ->assertJsonPath('user.permissions.center_roles.0', 'center_owner');
        $this->assertLessThanOrEqual(6, (int) $workspace->headers->get('X-Courses-Query-Count'));
        foreach (['', '?include=settings', '?include=audit'] as $suffix) {
            $page = $this->getJson('http://alpha.courses.test/api/v1/center/user'.$suffix)->assertOk();
            $this->assertLessThanOrEqual(6, (int) $page->headers->get('X-Courses-Query-Count'));
        }

        $version = $staffMembership->fresh()->grants_version;
        $failVersionUpdate = true;
        DB::connection('central')->listen(function (QueryExecuted $query) use (&$failVersionUpdate): void {
            if ($failVersionUpdate && $query->connectionName === 'central'
                && str_starts_with(strtolower(ltrim($query->sql)), 'update')
                && str_contains($query->sql, 'grants_version')) {
                $failVersionUpdate = false;
                throw new RuntimeException('Simulated central version failure');
            }
        });
        try {
            $this->putJson("http://alpha.courses.test/api/v1/center/members/{$staffMembership->id}/grants", [
                'center_roles' => [], 'branch_roles' => [(string) $branchId => ['branch_manager']],
            ])->assertStatus(500);
        } finally {
            $failVersionUpdate = false;
        }
        $this->assertSame($version, $staffMembership->fresh()->grants_version);
        $roles = $alpha->run(fn () => DB::table('branch_grants')->where('user_id', $staff->id)->pluck('role')->all());
        $this->assertEqualsCanonicalizing(['branch_viewer', 'branch_auditor'], $roles);

        $this->actingAs($staff)->withSession(['center_id' => $alpha->id]);
        $this->getJson("http://alpha.courses.test/api/v1/center/branches/{$branchId}")->assertOk();
        $this->patchJson("http://alpha.courses.test/api/v1/center/branches/{$branchId}", ['name' => 'Denied'])->assertForbidden();
        $this->getJson('http://alpha.courses.test/api/v1/center/members')->assertForbidden();
        $this->getJson('http://alpha.courses.test/api/v1/center/member-workspace')->assertForbidden();
        $this->getJson('http://beta.courses.test/api/v1/center/user')->assertUnauthorized();

        $this->actingAs($owner)->withSession(['center_id' => $alpha->id]);
        $this->putJson("http://alpha.courses.test/api/v1/center/members/{$staffMembership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [(string) $branchId => ['branch_manager', 'branch_auditor']],
        ])->assertOk();
        $this->actingAs($staff)->withSession(['center_id' => $alpha->id]);
        $this->patchJson("http://alpha.courses.test/api/v1/center/branches/{$branchId}", ['name' => 'Allowed'])->assertOk();
        $this->assertSame(0, $beta->run(fn () => DB::table('branch_grants')->count()));
    }
}
