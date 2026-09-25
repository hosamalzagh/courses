<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Symfony\Component\Console\Output\BufferedOutput;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class CenterMigrationCommandTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    public function test_operator_can_migrate_one_or_all_centers_without_a_broken_center_blocking_the_others(): void
    {
        $this->actingAs(User::factory()->create(['platform_role' => 'platform_owner']));
        foreach (['alpha', 'beta'] as $slug) {
            $this->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => ucfirst($slug).' Center', 'slug' => $slug, 'subdomain' => $slug,
                'plan' => 'starter', 'owner_email' => "owner@{$slug}.test",
            ])->assertCreated()->assertJsonPath('center.provisioning_status', 'active');
        }

        $alpha = Center::where('slug', 'alpha')->firstOrFail();
        $beta = Center::where('slug', 'beta')->firstOrFail();
        $output = new BufferedOutput;
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'beta'], $output));
        $singleResult = $output->fetch();
        $this->assertStringContainsString('beta: migrated', $singleResult);
        $this->assertStringNotContainsString('alpha:', $singleResult);

        tenancy()->end();
        DB::purge('tenant');
        $databaseName = $alpha->database()->getName();
        $this->assertMatchesRegularExpression('/^courses_center_[a-f0-9-]{36}$/', $databaseName);
        DB::connection('provisioning')->statement("DROP DATABASE \"{$databaseName}\" WITH (FORCE)");

        $output = new BufferedOutput;
        $this->assertSame(1, Artisan::call('courses:migrate-centers', [], $output));
        $result = $output->fetch();
        $this->assertStringContainsString('alpha: failed', $result);
        $this->assertStringContainsString('beta: migrated', $result);
        $this->assertSame('failed', $alpha->fresh()->provisioning_status);
        $this->assertSame('active', $beta->fresh()->provisioning_status);
        $this->assertSame('not_created', $alpha->fresh()->database_state);
        $this->assertNull($alpha->fresh()->migration_version);
        $this->assertStringContainsString('قاعدة بيانات المركز', $alpha->fresh()->provisioning_error);
        $this->assertSame('owner@beta.test', $beta->run(
            fn () => DB::table('center_settings')->where('id', 1)->value('contact_email'),
        ));

        $this->getJson('http://courses.test/api/v1/platform/centers')
            ->assertOk()->assertJsonFragment(['slug' => 'alpha'])->assertJsonFragment(['slug' => 'beta']);

        $this->postJson("http://courses.test/api/v1/platform/centers/{$alpha->id}/retry")
            ->assertOk()->assertJsonPath('center.provisioning_status', 'active');
        $this->assertSame(2, Center::count());
        $this->assertSame(1, DB::connection('central')->table('center_invitations')->where('tenant_id', $alpha->id)->count());
        $this->assertSame('active', $beta->fresh()->provisioning_status);
    }

    public function test_migration_failure_records_partial_version_and_does_not_block_the_next_center(): void
    {
        $this->actingAs(User::factory()->create(['platform_role' => 'platform_owner']));
        $alpha = Center::create([
            'name' => 'Alpha Center', 'slug' => 'alpha', 'plan' => 'starter',
            'owner_email' => 'owner@alpha.test',
        ]);
        $alpha->domains()->create(['domain' => 'alpha.courses.test']);
        $alpha->database()->manager()->createDatabase($alpha);
        $alpha->run(fn () => DB::statement('CREATE TABLE center_settings (id smallint PRIMARY KEY)'));

        $this->postJson('http://courses.test/api/v1/platform/centers', [
            'name' => 'Beta Center', 'slug' => 'beta', 'subdomain' => 'beta',
            'plan' => 'starter', 'owner_email' => 'owner@beta.test',
        ])->assertCreated()->assertJsonPath('center.provisioning_status', 'active');
        $beta = Center::where('slug', 'beta')->firstOrFail();

        $output = new BufferedOutput;
        $this->assertSame(1, Artisan::call('courses:migrate-centers', [], $output));
        $result = $output->fetch();
        $this->assertStringContainsString('alpha: failed', $result);
        $this->assertStringContainsString('beta: migrated', $result);
        $this->assertSame('failed', $alpha->fresh()->provisioning_status);
        $this->assertSame('available', $alpha->fresh()->database_state);
        $this->assertSame('2026_09_25_180000_create_center_tables', $alpha->fresh()->migration_version);
        $this->assertSame('active', $beta->fresh()->provisioning_status);
        $this->assertSame('owner@beta.test', $beta->run(
            fn () => DB::table('center_settings')->where('id', 1)->value('contact_email'),
        ));

        $alpha->run(fn () => DB::statement('DROP TABLE center_settings'));
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->assertSame('failed', $alpha->fresh()->provisioning_status);
        $this->postJson("http://courses.test/api/v1/platform/centers/{$alpha->id}/retry")
            ->assertOk()->assertJsonPath('center.provisioning_status', 'active');
        $this->assertSame(2, Center::count());
    }
}
