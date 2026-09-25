<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Schema;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class BranchManagementTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    public function test_owner_manages_two_branches_in_its_database_with_scoped_reads_and_audit(): void
    {
        Mail::fake();
        $this->actingAs(User::factory()->create(['platform_role' => 'platform_owner']));
        foreach (['alpha', 'beta'] as $slug) {
            $this->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => ucfirst($slug), 'slug' => $slug, 'subdomain' => $slug,
                'plan' => 'starter', 'owner_email' => "owner@{$slug}.test",
            ])->assertCreated();
        }

        $alpha = Center::where('slug', 'alpha')->firstOrFail();
        $beta = Center::where('slug', 'beta')->firstOrFail();
        $owner = User::factory()->create(['email_verified_at' => now()]);
        CenterMembership::create(['user_id' => $owner->id, 'tenant_id' => $alpha->id, 'status' => 'active']);
        $alpha->run(fn () => DB::table('center_grants')->insert([
            'user_id' => $owner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
        ]));
        $this->actingAs($owner)->withSession(['center_id' => $alpha->id]);

        $north = $this->postJson('http://alpha.courses.test/api/v1/center/branches', [
            'name' => 'North', 'slug' => 'north', 'address' => 'First Street',
        ])->assertCreated()->json('branch.id');
        $south = $this->postJson('http://alpha.courses.test/api/v1/center/branches', [
            'name' => 'South', 'slug' => 'south', 'address' => 'Second Street',
        ])->assertCreated()->json('branch.id');

        $list = $this->getJson('http://alpha.courses.test/api/v1/center/branches')
            ->assertOk()->assertJsonCount(2, 'branches')->assertJsonPath('branches.0.name', 'North');
        $this->assertLessThanOrEqual(6, (int) $list->headers->get('X-Courses-Query-Count'));
        $branch = $this->getJson("http://alpha.courses.test/api/v1/center/branches/{$south}")
            ->assertOk()->assertJsonPath('branch.name', 'South');
        $this->assertLessThanOrEqual(6, (int) $branch->headers->get('X-Courses-Query-Count'));
        $this->patchJson("http://alpha.courses.test/api/v1/center/branches/{$north}", [
            'name' => 'North Updated', 'address' => 'New Street',
        ])->assertOk()->assertJsonPath('branch.name', 'North Updated');
        $dashboard = $this->getJson('http://alpha.courses.test/api/v1/center/user')
            ->assertOk()->assertJsonCount(2, 'branches')->assertJsonPath('branches.0.name', 'North Updated');
        $this->assertLessThanOrEqual(6, (int) $dashboard->headers->get('X-Courses-Query-Count'));

        $events = $alpha->run(fn () => DB::table('center_audit_logs')->whereIn('branch_id', [$north, $south])
            ->orderBy('id')->get(['branch_id', 'actor_id', 'event']));
        $this->assertSame(['branch.created', 'branch.created', 'branch.updated'], $events->pluck('event')->all());
        $this->assertEqualsCanonicalizing([$north, $south, $north], $events->pluck('branch_id')->all());
        $this->assertTrue($events->every(fn ($event) => $event->actor_id === $owner->id));
        $this->assertSame(2, $alpha->run(fn () => DB::table('branches')->count()));
        $this->assertSame(0, $beta->run(fn () => DB::table('branches')->count()));
        $this->assertFalse(Schema::connection('central')->hasTable('branches'));
        $this->assertTrue(Model::preventsLazyLoading());

        $staff = User::factory()->create(['email_verified_at' => now()]);
        CenterMembership::create(['user_id' => $staff->id, 'tenant_id' => $alpha->id, 'status' => 'active']);
        $this->actingAs($staff)->withSession(['center_id' => $alpha->id]);
        $this->postJson('http://alpha.courses.test/api/v1/center/branches', [
            'name' => 'Denied', 'slug' => 'denied',
        ])->assertForbidden();
        $this->patchJson("http://alpha.courses.test/api/v1/center/branches/{$north}", ['name' => 'Denied'])
            ->assertForbidden();
        $this->getJson("http://alpha.courses.test/api/v1/center/branches/{$north}")->assertForbidden();
        $this->getJson('http://alpha.courses.test/api/v1/center/branches')->assertOk()->assertJsonCount(0, 'branches');

        $betaOwner = User::factory()->create(['email_verified_at' => now()]);
        CenterMembership::create(['user_id' => $betaOwner->id, 'tenant_id' => $beta->id, 'status' => 'active']);
        $beta->run(fn () => DB::table('center_grants')->insert([
            'user_id' => $betaOwner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
        ]));
        $this->actingAs($betaOwner)->withSession(['center_id' => $beta->id]);
        $this->postJson('http://beta.courses.test/api/v1/center/branches', [
            'name' => 'Beta Branch', 'slug' => 'beta-branch',
        ])->assertCreated();
        $this->getJson("http://beta.courses.test/api/v1/center/branches/{$south}")->assertNotFound();
        $this->patchJson("http://beta.courses.test/api/v1/center/branches/{$south}", ['name' => 'Cross Center'])
            ->assertNotFound();
        $this->assertSame('South', $alpha->run(fn () => DB::table('branches')->where('id', $south)->value('name')));
    }
}
