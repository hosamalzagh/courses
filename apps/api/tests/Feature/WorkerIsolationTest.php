<?php

namespace Tests\Feature;

use App\Jobs\ProvisionCenter;
use App\Models\Center;
use App\Models\CenterInvitation;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Str;
use Symfony\Component\Process\Process;
use Tests\Concerns\CleansCenterDatabases;
use Tests\Support\ProbePlatformContext;
use Tests\Support\ProbeTenantContext;
use Tests\TestCase;

class WorkerIsolationTest extends TestCase
{
    use CleansCenterDatabases;

    public function test_one_redis_worker_reverts_tenant_database_and_cache_even_after_a_failed_job(): void
    {
        abort_unless(config('database.connections.central.database') === 'courses_test_central', 500);
        $this->assertSame(['default'], config('horizon.defaults.supervisor-1.queue'));
        $this->assertSame('redis', config('horizon.defaults.supervisor-1.connection'));
        $this->assertSame(['platform'], config('horizon.defaults.supervisor-platform.queue'));
        $this->assertSame('platform', config('horizon.defaults.supervisor-platform.connection'));
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
        foreach ([['alpha', 1, false], ['alpha', 2, true], ['beta', 3, false], ['alpha', 4, false]] as [$slug, $sequence, $fail]) {
            $centers[$slug]->run(fn () => Queue::connection('redis')->push(
                new ProbeTenantContext($runId, $sequence, $fail ? 'alpha-failed' : $slug, $fail), '', $queue,
            ));
        }

        $worker = new Process([
            PHP_BINARY, 'artisan',
            'queue:work', 'redis', '--queue='.$queue, '--max-jobs=4', '--stop-when-empty',
            '--sleep=1', '--tries=1', '--no-interaction', '--env=testing',
        ], base_path(), ['APP_ENV' => 'testing', 'DB_DATABASE' => 'courses_test_central']);
        $worker->setTimeout(40);
        try {
            $worker->mustRun();

            $results = [];
            foreach ([1, 2, 3, 4] as $sequence) {
                $key = "courses:worker-proof:{$runId}:{$sequence}";
                $results[] = json_decode((string) Redis::get($key), true);
            }

            $this->assertSame($centers['alpha']->id, $results[0]['tenant']);
            $this->assertNull($results[0]['seen']);
            $this->assertSame(['alpha'], $results[0]['branches']);
            $this->assertSame([], $results[0]['audit_before']);
            $this->assertSame($centers['alpha']->id, $results[1]['tenant']);
            $this->assertSame('alpha', $results[1]['seen']);
            $this->assertSame(['alpha'], $results[1]['branches']);
            $this->assertSame([1], $results[1]['audit_before']);
            $this->assertTrue($results[1]['failed']);
            $this->assertSame($centers['beta']->id, $results[2]['tenant']);
            $this->assertNull($results[2]['seen']);
            $this->assertSame(['beta'], $results[2]['branches']);
            $this->assertSame([], $results[2]['audit_before']);
            $this->assertSame($centers['alpha']->id, $results[3]['tenant']);
            $this->assertSame('alpha-failed', $results[3]['seen']);
            $this->assertSame(['alpha'], $results[3]['branches']);
            $this->assertSame([1, 2], $results[3]['audit_before']);
            $this->assertCount(1, array_unique(array_column($results, 'worker_pid')));
            $this->assertSame(1, DB::connection('central')->table('failed_jobs')->where('payload', 'like', '%'.$runId.'%')->count());
            $this->assertSame([1, 2, 4], $centers['alpha']->run(fn () => DB::table('center_audit_logs')
                ->where('event', 'test.worker.probe')->orderBy('id')->pluck('details')
                ->map(fn ($details) => json_decode($details, true)['sequence'])->all()));
            $this->assertSame([3], $centers['beta']->run(fn () => DB::table('center_audit_logs')
                ->where('event', 'test.worker.probe')->orderBy('id')->pluck('details')
                ->map(fn ($details) => json_decode($details, true)['sequence'])->all()));
            $this->assertFalse(tenancy()->initialized);
        } finally {
            Queue::connection('redis')->clear($queue);
            foreach ([1, 2, 3, 4] as $sequence) {
                Redis::del("courses:worker-proof:{$runId}:{$sequence}");
            }
            DB::connection('central')->table('failed_jobs')->where('payload', 'like', '%'.$runId.'%')->delete();
        }
    }

    public function test_one_platform_redis_worker_delivers_distinct_owner_invitations_after_a_failed_job(): void
    {
        abort_unless(config('database.connections.central.database') === 'courses_test_central', 500);
        Artisan::call('migrate:fresh', ['--database' => 'central', '--force' => true]);
        $centers = [];
        foreach (['alpha', 'beta'] as $slug) {
            $center = Center::create([
                'name' => ucfirst($slug), 'slug' => $slug, 'plan' => 'starter',
                'owner_email' => "owner@{$slug}.test",
            ]);
            $center->domains()->create(['domain' => "{$slug}.courses.test"]);
            $centers[$slug] = $center;
        }

        $runId = (string) Str::uuid();
        $queue = 'platform-isolation-'.$runId;
        config(['queue.connections.platform.driver' => 'redis']);
        try {
            foreach ([['alpha', 1, true], ['alpha', 2, false], ['beta', 3, false]] as [$slug, $sequence, $fail]) {
                $center = $centers[$slug];
                $job = new ProbePlatformContext($center->id, $runId, $sequence, $fail);
                $this->assertSame('platform', $job->connection);
                $this->assertSame('platform', $job->queue);
                $center->run(fn () => Queue::connection('platform')->push($job, '', $queue));
            }
            $payloads = Redis::lrange('queues:'.$queue, 0, -1);
            $this->assertCount(3, $payloads);
            foreach ($payloads as $payload) {
                $this->assertArrayNotHasKey('tenant_id', json_decode($payload, true));
            }
            $worker = new Process([
                PHP_BINARY, 'artisan', 'queue:work', 'platform', '--queue='.$queue, '--max-jobs=3',
                '--stop-when-empty', '--sleep=1', '--tries=1', '--no-interaction', '--env=testing',
            ], base_path(), [
                'APP_ENV' => 'testing', 'DB_DATABASE' => 'courses_test_central',
                'MAIL_MAILER' => 'array', 'PLATFORM_QUEUE_DRIVER' => 'redis',
            ]);
            $worker->setTimeout(60);
            $worker->mustRun();

            $results = [];
            foreach ([1, 2, 3] as $sequence) {
                $results[] = json_decode((string) Redis::get("courses:platform-worker-proof:{$runId}:{$sequence}"), true);
            }
            $this->assertCount(1, array_unique(array_column($results, 'worker_pid')));
            foreach ($results as $result) {
                $this->assertNull($result['tenant']);
                $this->assertSame('central', $result['connection']);
            }
            $this->assertSame(1, DB::connection('central')->table('failed_jobs')->where('queue', $queue)->count());

            $invitations = CenterInvitation::whereIn('tenant_id', array_map(fn (Center $center) => $center->id, $centers))
                ->get()->keyBy('tenant_id');
            $this->assertCount(2, $invitations);
            $this->assertNotSame($invitations[$centers['alpha']->id]->token_hash, $invitations[$centers['beta']->id]->token_hash);
            foreach ($centers as $slug => $center) {
                $this->assertSame('active', $center->fresh()->provisioning_status);
                $this->assertSame("owner@{$slug}.test", $invitations[$center->id]->email);
                $this->assertNotNull($invitations[$center->id]->sent_at);
                $contactEmail = $center->run(fn (): string => DB::table('center_settings')->value('contact_email'));
                $this->assertSame("owner@{$slug}.test", $contactEmail);
            }
            $this->assertFalse(tenancy()->initialized);
        } finally {
            Queue::connection('platform')->clear($queue);
            foreach ([1, 2, 3] as $sequence) {
                Redis::del("courses:platform-worker-proof:{$runId}:{$sequence}");
            }
            DB::connection('central')->table('failed_jobs')->where('queue', $queue)->delete();
        }
    }
}
