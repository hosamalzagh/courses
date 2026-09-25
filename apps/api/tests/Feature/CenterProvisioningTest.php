<?php

namespace Tests\Feature;

use App\Filament\Resources\Centers\Pages\CreateCenter;
use App\Filament\Resources\Centers\Pages\ViewCenter;
use App\Jobs\ProvisionCenter;
use App\Models\Center;
use App\Models\User;
use Filament\Facades\Filament;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Queue;
use Livewire\Livewire;
use RuntimeException;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class CenterProvisioningTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    public function test_landlord_creation_stays_pending_until_provisioning_runs_and_rejects_duplicate_identity(): void
    {
        Queue::fake();
        Filament::setCurrentPanel(Filament::getPanel('admin'));
        $this->actingAs(User::factory()->create(['platform_role' => 'platform_owner']));

        Livewire::test(CreateCenter::class)
            ->fillForm([
                'name' => 'Alpha Center', 'slug' => 'alpha', 'subdomain' => 'alpha',
                'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
            ])
            ->call('create')
            ->assertHasNoFormErrors();

        $center = Center::where('slug', 'alpha')->firstOrFail();
        $this->assertSame('pending', $center->provisioning_status);
        $this->assertSame('alpha.courses.test', $center->domains()->firstOrFail()->domain);
        Queue::assertPushed(ProvisionCenter::class, fn (ProvisionCenter $job) => $job->centerId === $center->id && $job->connection === 'platform' && $job->queue === 'platform');

        Livewire::test(CreateCenter::class)
            ->fillForm([
                'name' => 'Duplicate', 'slug' => 'alpha', 'subdomain' => 'different',
                'plan' => 'starter', 'owner_email' => 'duplicate@alpha.test',
            ])
            ->call('create')
            ->assertHasFormErrors(['slug']);

        Livewire::test(CreateCenter::class)
            ->fillForm([
                'name' => 'Duplicate', 'slug' => 'different', 'subdomain' => 'alpha',
                'plan' => 'starter', 'owner_email' => 'duplicate@alpha.test',
            ])
            ->call('create')
            ->assertHasFormErrors(['subdomain']);

        $this->assertSame(1, Center::count());
    }

    public function test_platform_owner_can_create_and_retry_a_center_without_duplicate_identity(): void
    {
        $owner = User::factory()->create(['platform_role' => 'platform_owner']);
        $this->actingAs($owner);

        $response = $this->withServerVariables(['HTTP_HOST' => 'courses.test'])
            ->postJson('/api/v1/platform/centers', [
                'name' => 'Alpha Center',
                'slug' => 'alpha',
                'subdomain' => 'alpha',
                'plan' => 'starter',
                'owner_email' => 'owner@alpha.test',
            ]);

        $response->assertCreated()->assertJsonPath('center.provisioning_status', 'active');
        $center = Center::where('slug', 'alpha')->firstOrFail();
        $this->assertSame(1, $center->domains()->count());
        $this->assertSame(1, DB::connection('central')->table('center_invitations')->where('tenant_id', $center->id)->count());
        $this->assertTrue((bool) DB::connection('central')->selectOne(
            'SELECT 1 FROM pg_database WHERE datname = ?', [$center->database()->getName()],
        ));
        $this->assertFalse(DB::connection('central')->selectOne(
            'SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user',
        )->rolcreatedb);
        $this->assertNotSame(
            config('database.connections.central.username'),
            config('database.connections.provisioning.username'),
        );
        $this->assertSame('owner@alpha.test', $center->run(
            fn () => DB::table('center_settings')->where('id', 1)->value('contact_email'),
        ));

        $center->update(['provisioning_status' => 'failed']);

        $this->withServerVariables(['HTTP_HOST' => 'courses.test'])
            ->postJson("/api/v1/platform/centers/{$center->id}/retry")
            ->assertOk()->assertJsonPath('center.provisioning_status', 'active');

        $this->assertSame(1, DB::connection('central')->table('center_invitations')->where('tenant_id', $center->id)->count());
        $this->assertSame(1, Center::where('slug', 'alpha')->count());
    }

    public function test_failed_database_provisioning_can_be_retried_without_duplicate_center_or_invitation(): void
    {
        $owner = User::factory()->create(['platform_role' => 'platform_owner']);
        $this->actingAs($owner);
        $port = config('database.connections.provisioning.port');
        config()->set('database.connections.provisioning.port', 1);
        DB::purge('provisioning');
        try {
            $this->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => 'Gamma Center', 'slug' => 'gamma', 'subdomain' => 'gamma',
                'plan' => 'starter', 'owner_email' => 'owner@gamma.test',
            ])->assertCreated()->assertJsonPath('center.provisioning_status', 'failed');
        } finally {
            config()->set('database.connections.provisioning.port', $port);
            DB::purge('provisioning');
        }

        $center = Center::where('slug', 'gamma')->firstOrFail();
        $this->assertSame('not_created', $center->database_state);
        $this->assertStringContainsString('إنشاء قاعدة بيانات المركز', $center->provisioning_error);
        $this->assertStringNotContainsString('Exception', $center->provisioning_error);
        $this->postJson("http://courses.test/api/v1/platform/centers/{$center->id}/retry")
            ->assertOk()->assertJsonPath('center.provisioning_status', 'active');
        $this->assertSame(1, Center::where('slug', 'gamma')->count());
        $this->assertSame(1, DB::connection('central')->table('center_invitations')->where('tenant_id', $center->id)->count());
    }

    public function test_failed_migration_keeps_its_applied_version_and_retry_preserves_the_other_center(): void
    {
        $this->actingAs(User::factory()->create(['platform_role' => 'platform_owner']));
        $this->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Alpha Center', 'slug' => 'alpha', 'subdomain' => 'alpha',
            'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
        ])->assertCreated();
        $alpha = Center::where('slug', 'alpha')->firstOrFail();
        User::factory()->create(['email' => 'owner@beta.test']);

        $beta = Center::create([
            'name' => 'Beta Center', 'slug' => 'beta', 'plan' => 'starter',
            'owner_email' => 'owner@beta.test',
        ]);
        $beta->domains()->create(['domain' => 'beta.courses.test']);
        $beta->database()->manager()->createDatabase($beta);
        $beta->run(fn () => DB::statement('CREATE TABLE center_settings (id smallint PRIMARY KEY)'));

        ProvisionCenter::dispatch($beta->id);
        $beta->refresh();
        $this->assertSame('failed', $beta->provisioning_status);
        $this->assertSame('available', $beta->database_state);
        $this->assertSame('2026_09_25_180000_create_center_tables', $beta->migration_version);
        $this->assertStringContainsString('ترحيل قاعدة بيانات المركز', $beta->provisioning_error);
        $this->assertStringNotContainsString('password', strtolower($beta->provisioning_error));
        $this->assertSame('active', $alpha->fresh()->provisioning_status);
        $this->assertSame(0, DB::connection('central')->table('center_invitations')->where('tenant_id', $beta->id)->count());
        Filament::setCurrentPanel(Filament::getPanel('admin'));
        Livewire::test(ViewCenter::class, ['record' => $beta->id])
            ->assertSee('تعذر ترحيل قاعدة بيانات المركز')
            ->assertSee('2026_09_25_180000_create_center_tables');

        $beta->run(fn () => DB::statement('DROP TABLE center_settings'));
        $this->postJson("http://courses.test/api/v1/platform/centers/{$beta->id}/retry")
            ->assertOk()->assertJsonPath('center.provisioning_status', 'active');

        $this->assertSame(2, Center::count());
        $this->assertSame(1, DB::connection('central')->table('center_invitations')->where('tenant_id', $beta->id)->count());
        $this->assertSame(1, User::where('email', 'owner@beta.test')->count());
        $this->assertSame('active', $alpha->fresh()->provisioning_status);
        $this->assertSame('owner@beta.test', $beta->run(
            fn () => DB::table('center_settings')->where('id', 1)->value('contact_email'),
        ));
    }

    public function test_changing_a_center_domain_rejects_the_old_host(): void
    {
        $owner = User::factory()->create(['platform_role' => 'platform_owner']);
        $this->actingAs($owner)->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Alpha Center', 'slug' => 'alpha', 'subdomain' => 'alpha',
            'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
        ])->assertCreated();
        $center = Center::where('slug', 'alpha')->firstOrFail();
        $this->putJson("http://courses.test/api/v1/platform/centers/{$center->id}/domain", ['subdomain' => 'renamed'])
            ->assertOk()->assertJsonPath('center.domains.0.domain', 'renamed.courses.test');
        $this->getJson('http://alpha.courses.test/api/v1/center/user')->assertNotFound();
        $this->getJson('http://renamed.courses.test/api/v1/center/user')->assertUnauthorized();
    }

    public function test_platform_support_can_read_center_status_but_cannot_create_centers_or_read_tenant_data(): void
    {
        $owner = User::factory()->create(['platform_role' => 'platform_owner']);
        $this->actingAs($owner)->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Alpha Center', 'slug' => 'alpha', 'subdomain' => 'alpha',
            'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
        ])->assertCreated();
        $support = User::factory()->create(['platform_role' => 'platform_support']);
        $this->actingAs($support);
        $this->getJson('http://courses.test/api/v1/platform/centers')->assertOk();
        $this->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Denied', 'slug' => 'denied', 'subdomain' => 'denied',
            'plan' => 'starter', 'owner_email' => 'owner@denied.test',
        ])->assertForbidden();
        $this->getJson('http://alpha.courses.test/api/v1/center/user')->assertUnauthorized();
    }

    public function test_center_changes_roll_back_when_their_platform_audit_cannot_be_written(): void
    {
        $owner = User::factory()->create(['platform_role' => 'platform_owner']);
        $this->actingAs($owner)->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Alpha Center', 'slug' => 'alpha', 'subdomain' => 'alpha',
            'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
        ])->assertCreated();
        $center = Center::where('slug', 'alpha')->firstOrFail();

        $failAuditInsert = false;
        DB::connection('central')->listen(function (QueryExecuted $query) use (&$failAuditInsert): void {
            if ($failAuditInsert && $query->connectionName === 'central'
                && str_contains(strtolower($query->sql), 'insert into "platform_audit_logs"')) {
                $failAuditInsert = false;
                throw new RuntimeException('Simulated platform audit failure');
            }
        });
        $failAuditInsert = true;
        $this->patchJson("http://courses.test/api/v1/platform/centers/{$center->id}", [
            'name' => 'Not Saved', 'suspended' => true,
        ])->assertStatus(500);
        $this->assertSame('Alpha Center', $center->fresh()->name);
        $this->assertFalse($center->fresh()->suspended);

        $failAuditInsert = true;
        $this->putJson("http://courses.test/api/v1/platform/centers/{$center->id}/domain", [
            'subdomain' => 'not-saved',
        ])->assertStatus(500);
        $this->assertSame('alpha.courses.test', $center->domains()->firstOrFail()->domain);
    }
}
