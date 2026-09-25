<?php

namespace Tests\Feature;

use App\Jobs\ProvisionCenter;
use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class CenterRestoreTest extends TestCase
{
    use CleansCenterDatabases;

    public function test_restoring_alpha_keeps_beta_and_central_identity_and_removes_orphan_grants(): void
    {
        abort_unless(config('database.connections.central.database') === 'courses_test_central', 500);
        Artisan::call('migrate:fresh', ['--database' => 'central', '--force' => true]);
        Mail::fake();
        foreach (['alpha', 'beta'] as $slug) {
            $center = Center::create([
                'name' => ucfirst($slug), 'slug' => $slug, 'plan' => 'starter',
                'owner_email' => "owner@{$slug}.test",
            ]);
            $center->domains()->create(['domain' => "{$slug}.courses.test"]);
            ProvisionCenter::dispatchSync($center->id);
            $center->run(fn () => DB::table('branches')->insert([
                'name' => $slug, 'slug' => $slug, 'created_at' => now(), 'updated_at' => now(),
            ]));
        }
        $alpha = Center::where('slug', 'alpha')->firstOrFail();
        $beta = Center::where('slug', 'beta')->firstOrFail();
        $owner = User::factory()->create(['email_verified_at' => now()]);
        CenterMembership::create(['tenant_id' => $alpha->id, 'user_id' => $owner->id, 'status' => 'active']);
        $alpha->run(function () use ($owner): void {
            foreach ([$owner->id, 999999] as $userId) {
                DB::table('center_grants')->insert([
                    'user_id' => $userId, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
                ]);
            }
        });

        $this->assertSame(0, Artisan::call('courses:backup', ['slug' => 'alpha']));
        $files = glob(storage_path("app/private/backups/alpha-{$alpha->id}-*.dump"));
        $file = end($files);
        $this->assertFileExists($file);
        $alpha->run(fn () => DB::table('branches')->insert([
            'name' => 'temporary', 'slug' => 'temporary', 'created_at' => now(), 'updated_at' => now(),
        ]));

        $this->assertSame(0, Artisan::call('courses:restore', [
            'slug' => 'alpha', 'file' => $file, '--confirm' => 'alpha',
        ]));
        $this->assertSame(['alpha'], $alpha->run(fn () => DB::table('branches')->pluck('slug')->all()));
        $this->assertSame(['beta'], $beta->run(fn () => DB::table('branches')->pluck('slug')->all()));
        $this->assertSame(0, $alpha->run(fn () => DB::table('center_grants')->where('user_id', 999999)->count()));
        $this->actingAs($owner)->withSession(['center_id' => $alpha->id]);
        $this->getJson('http://alpha.courses.test/api/v1/center/user')
            ->assertOk()->assertJsonPath('permissions.center_roles.0', 'center_owner');
        unlink($file);

    }
}
