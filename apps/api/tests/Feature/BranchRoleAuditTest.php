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

class BranchRoleAuditTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    public function test_branch_roles_combine_and_audit_stays_within_the_assigned_branch(): void
    {
        Mail::fake();
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')
            ->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha',
                'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
            ])->assertCreated();
        $center = Center::where('slug', 'alpha')->firstOrFail();
        $owner = User::factory()->create(['email_verified_at' => now()]);
        $staff = User::factory()->create(['email_verified_at' => now()]);
        $subject = User::factory()->create(['email_verified_at' => now()]);
        CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $owner->id, 'status' => 'active']);
        $membership = CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $staff->id, 'status' => 'active']);
        $subjectMembership = CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $subject->id, 'status' => 'active']);
        $center->run(fn () => DB::table('center_grants')->insert([
            'user_id' => $owner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
        ]));

        $base = 'http://alpha.courses.test/api/v1/center';
        $this->actingAs($owner, 'web')->withSession(['center_id' => $center->id]);
        $north = $this->postJson("{$base}/branches", ['name' => 'North', 'slug' => 'north'])
            ->assertCreated()->json('branch.id');
        $south = $this->postJson("{$base}/branches", ['name' => 'South', 'slug' => 'south'])
            ->assertCreated()->json('branch.id');
        $this->putJson("{$base}/members/{$membership->id}/grants", [
            'center_roles' => [],
            'branch_roles' => [
                (string) $north => ['branch_manager', 'branch_auditor'],
                (string) $south => ['branch_viewer'],
            ],
        ])->assertOk();
        $this->putJson("{$base}/members/{$subjectMembership->id}/grants", [
            'center_roles' => [],
            'branch_roles' => [(string) $north => ['branch_viewer'], (string) $south => ['branch_viewer']],
        ])->assertOk();
        $this->patchJson("{$base}/members/{$subjectMembership->id}/status", ['status' => 'suspended'])
            ->assertOk();
        $ownerAudit = $this->getJson("{$base}/audit")->assertOk();
        $this->assertSame(1, collect($ownerAudit->json('entries'))
            ->where('event', 'member.status_changed')->count());
        $this->assertSame(0, collect($ownerAudit->json('entries'))
            ->where('event', 'member.branch_status_changed')->count());

        $this->actingAs($staff, 'web')->withSession(['center_id' => $center->id]);
        $user = $this->getJson("{$base}/user")->assertOk()
            ->assertJsonCount(2, 'user.permissions.branch_roles.'.$north)
            ->assertJsonCount(1, 'user.permissions.branch_roles.'.$south);
        $this->assertQueryBudget($user);
        $this->patchJson("{$base}/branches/{$north}", ['name' => 'North Updated'])->assertOk();
        $this->patchJson("{$base}/branches/{$south}", ['name' => 'Denied'])->assertForbidden();
        $northAudit = $this->getJson("{$base}/branches/{$north}/audit")->assertOk()
            ->assertJsonFragment(['event' => 'member.branch_grants_changed'])
            ->assertJsonFragment(['event' => 'member.branch_status_changed']);
        $this->assertQueryBudget($northAudit);
        $this->getJson("{$base}/branches/{$south}/audit")->assertForbidden();
        $auditPage = $this->getJson("{$base}/user?include=audit")->assertOk()
            ->assertJsonFragment(['event' => 'branch.updated']);
        $this->assertQueryBudget($auditPage);
        $this->assertSame([$north], collect($auditPage->json('audit_entries'))->pluck('branch_id')->unique()->all());

        $this->actingAs($owner, 'web')->withSession(['center_id' => $center->id]);
        $this->putJson("{$base}/members/{$membership->id}/grants", [
            'center_roles' => [], 'branch_roles' => [(string) $north => ['branch_viewer']],
        ])->assertOk();
        $this->actingAs($staff, 'web')->withSession(['center_id' => $center->id]);
        $this->patchJson("{$base}/branches/{$north}", ['name' => 'Denied'])->assertForbidden();
        $this->getJson("{$base}/branches/{$north}/audit")->assertForbidden();
        $this->getJson("{$base}/user?include=audit")->assertForbidden();
        $this->getJson("{$base}/branches/{$south}")->assertForbidden();
    }

    private function assertQueryBudget(TestResponse $response): void
    {
        $count = $response->headers->get('X-Courses-Query-Count');
        $this->assertNotNull($count);
        $this->assertMatchesRegularExpression('/^\d+$/', $count);
        $this->assertLessThanOrEqual(6, (int) $count);
    }
}
