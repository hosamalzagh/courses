<?php

namespace Tests\Feature;

use App\Jobs\ProvisionCenter;
use App\Models\Center;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Str;
use Symfony\Component\Process\Process;
use Tests\Concerns\CleansCenterDatabases;
use Tests\Support\ProbeTenantContext;
use Tests\TestCase;

class WorkerIsolationTest extends TestCase
{
    use CleansCenterDatabases;

    public function test_one_redis_worker_reverts_tenant_database_and_cache_between_jobs(): void
    {
        abort_unless(config('database.connections.central.database') === 'courses_test_central', 500);
        Artisan::call('migrate:fresh', ['--database' => 'central', '--force' => true]);
        Mail::fake();
        $centers = [];
        foreach (['alpha', 'beta'] as $slug) {
            $center = Center::create([
                'name' => ucfirst($slug), 'slug' => $slug, 'plan' => 'starter',
                'owner_email' => "owner@{$slug}.test",
            ]);
            $center->domains()->create(['domain' => "{$slug}.courses.test"]);
            ProvisionCenter::dispatchSync($center->id);
            $this->assertSame('active', $center->fresh()->provisioning_status);
            $center->run(function () use ($slug): void {
                DB::table('branches')->insert([
                    'name' => $slug, 'slug' => $slug, 'created_at' => now(), 'updated_at' => now(),
                ]);
                Cache::forget('worker-isolation-probe');
            });
            $centers[$slug] = $center;
        }

        $runId = (string) Str::uuid();
        $queue = 'isolation-'.$runId;
        foreach ([['alpha', 1], ['beta', 2], ['alpha', 3]] as [$slug, $sequence]) {
            $centers[$slug]->run(fn () => Queue::connection('redis')->push(
                new ProbeTenantContext($runId, $sequence, $slug), '', $queue,
            ));
        }

        $worker = new Process([
            PHP_BINARY, 'artisan',
            'queue:work', 'redis', '--queue='.$queue, '--max-jobs=3', '--stop-when-empty',
            '--sleep=1', '--tries=1', '--no-interaction', '--env=testing',
        ], base_path(), ['APP_ENV' => 'testing', 'DB_DATABASE' => 'courses_test_central']);
        $worker->setTimeout(40);
        $worker->mustRun();

        $results = [];
        foreach ([1, 2, 3] as $sequence) {
            $key = "courses:worker-proof:{$runId}:{$sequence}";
            $results[] = json_decode((string) Redis::get($key), true);
            Redis::del($key);
        }

        $this->assertSame($centers['alpha']->id, $results[0]['tenant']);
        $this->assertNull($results[0]['seen']);
        $this->assertSame(['alpha'], $results[0]['branches']);
        $this->assertSame($centers['beta']->id, $results[1]['tenant']);
        $this->assertNull($results[1]['seen']);
        $this->assertSame(['beta'], $results[1]['branches']);
        $this->assertSame($centers['alpha']->id, $results[2]['tenant']);
        $this->assertSame('alpha', $results[2]['seen']);
        $this->assertSame(['alpha'], $results[2]['branches']);
        $this->assertFalse(tenancy()->initialized);

    }
}
