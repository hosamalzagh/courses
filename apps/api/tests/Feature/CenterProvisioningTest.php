<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class CenterProvisioningTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

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
}
