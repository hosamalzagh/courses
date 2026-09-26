<?php

namespace Tests\Support;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Redis;
use RuntimeException;

class ProbeTenantContext implements ShouldQueue
{
    use InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(public string $runId, public int $sequence, public string $writeValue, public bool $fail = false) {}

    public function handle(): void
    {
        $seen = Cache::get('worker-isolation-probe');
        $branches = DB::connection('tenant')->table('branches')->pluck('slug')->all();
        $auditBefore = DB::connection('tenant')->table('center_audit_logs')
            ->where('event', 'test.worker.probe')
            ->whereRaw("details->>'run_id' = ?", [$this->runId])
            ->orderBy('id')->pluck('details')
            ->map(fn ($details) => json_decode($details, true)['sequence'])->all();
        DB::connection('tenant')->table('center_audit_logs')->insert([
            'actor_id' => null, 'branch_id' => null, 'event' => 'test.worker.probe',
            'details' => json_encode(['run_id' => $this->runId, 'sequence' => $this->sequence]),
            'created_at' => now(),
        ]);
        Cache::put('worker-isolation-probe', $this->writeValue, 60);
        Redis::setex("courses:worker-proof:{$this->runId}:{$this->sequence}", 120, json_encode([
            'tenant' => tenant('id'), 'seen' => $seen, 'branches' => $branches,
            'audit_before' => $auditBefore, 'worker_pid' => getmypid(), 'failed' => $this->fail,
        ]));
        if ($this->fail) {
            throw new RuntimeException('Intentional tenant worker isolation probe failure.');
        }
    }
}
