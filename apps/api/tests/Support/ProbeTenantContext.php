<?php

namespace Tests\Support;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Redis;

class ProbeTenantContext implements ShouldQueue
{
    use InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(public string $runId, public int $sequence, public string $writeValue) {}

    public function handle(): void
    {
        $seen = Cache::get('worker-isolation-probe');
        $branches = DB::connection('tenant')->table('branches')->pluck('slug')->all();
        Cache::put('worker-isolation-probe', $this->writeValue, 60);
        Redis::set("courses:worker-proof:{$this->runId}:{$this->sequence}", json_encode([
            'tenant' => tenant('id'), 'seen' => $seen, 'branches' => $branches,
        ]));
    }
}
