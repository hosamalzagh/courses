<?php

namespace Tests\Feature;

use App\Filament\Resources\Centers\Pages\EditCenter;
use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Filament\Facades\Filament;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Livewire\Livewire;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class PlatformCenterLifecycleTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    public function test_owner_suspends_reactivates_and_changes_managed_domain_without_tenant_reads(): void
    {
        Mail::fake();
        $platformOwner = User::factory()->platformOwner()->create();
        $this->actingAs($platformOwner, 'platform')->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha',
            'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
        ])->assertCreated();
        $center = Center::where('slug', 'alpha')->firstOrFail();
        $staff = User::factory()->create();
        CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $staff->id, 'status' => 'active']);
        $this->actingAs($staff, 'web')->withSession(['center_id' => $center->id]);
        $this->getJson('http://alpha.courses.test/api/v1/center/user')->assertOk();

        Filament::setCurrentPanel(Filament::getPanel('admin'));
        $this->actingAs($platformOwner, 'platform');
        Livewire::test(EditCenter::class, ['record' => $center->id])
            ->fillForm([
                'name' => 'Alpha Updated', 'subdomain' => 'alpha',
                'plan' => 'growth', 'suspended' => true,
            ])->call('save')->assertHasNoFormErrors();
        $this->assertTrue($center->fresh()->suspended);
        $this->assertSame('growth', $center->fresh()->plan);
        $this->assertSame('Alpha Updated', $center->fresh()->name);

        $connections = [];
        $measuring = false;
        DB::listen(function (QueryExecuted $query) use (&$connections, &$measuring): void {
            if ($measuring) {
                $connections[] = $query->connectionName;
            }
        });
        $this->actingAs($staff, 'web')->withSession(['center_id' => $center->id]);
        $measuring = true;
        $suspended = $this->getJson('http://alpha.courses.test/api/v1/center/user')->assertStatus(423)
            ->assertDontSee($staff->email);
        $measuring = false;
        $this->assertNotContains('tenant', $connections);

        $this->actingAs($platformOwner, 'platform');
        $this->getJson("http://courses.test/api/v1/platform/centers/{$center->id}")
            ->assertOk()->assertJsonPath('center.suspended', true);
        $statusPage = $this->get("http://courses.test/admin/centers/{$center->id}")->assertOk();
        $editPage = $this->get("http://courses.test/admin/centers/{$center->id}/edit")->assertOk();
        foreach ([$suspended, $statusPage, $editPage] as $response) {
            $count = $response->headers->get('X-Courses-Query-Count');
            $this->assertNotNull($count);
            $this->assertGreaterThan(0, (int) $count);
            $this->assertLessThanOrEqual(6, (int) $count);
        }

        $this->patchJson("http://courses.test/api/v1/platform/centers/{$center->id}", ['plan' => 'arbitrary'])
            ->assertUnprocessable();
        $this->putJson("http://courses.test/api/v1/platform/centers/{$center->id}/domain", [
            'subdomain' => 'external.example.com',
        ])->assertUnprocessable();
        $other = Center::create([
            'name' => 'Beta', 'slug' => 'beta', 'plan' => 'starter', 'owner_email' => 'owner@beta.test',
        ]);
        $other->domains()->create(['domain' => 'beta.courses.test']);
        $this->putJson("http://courses.test/api/v1/platform/centers/{$center->id}/domain", [
            'subdomain' => 'beta',
        ])->assertUnprocessable();
        $this->putJson("http://courses.test/api/v1/platform/centers/{$center->id}/domain", [
            'subdomain' => 'alpha-new',
        ])->assertOk()->assertJsonPath('center.domains.0.domain', 'alpha-new.courses.test');
        $this->getJson('http://alpha.courses.test/api/v1/center/user')->assertNotFound();
        $this->getJson('http://alpha-new.courses.test/api/v1/center/user')->assertStatus(423);
        $this->patchJson("http://courses.test/api/v1/platform/centers/{$center->id}", ['suspended' => false])
            ->assertOk()->assertJsonPath('center.suspended', false);
        $this->actingAs($staff, 'web')->withSession(['center_id' => $center->id]);
        $this->getJson('http://alpha-new.courses.test/api/v1/center/user')->assertOk();

        $events = DB::connection('central')->table('platform_audit_logs')
            ->where('tenant_id', $center->id)->pluck('event')->all();
        $this->assertContains('center.updated', $events);
        $this->assertContains('center.domain_changed', $events);
    }
}
