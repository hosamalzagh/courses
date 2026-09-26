<?php

namespace Tests\Support;

use App\Jobs\ProvisionCenter;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Redis;
use RuntimeException;

class ProbePlatformContext extends ProvisionCenter
{
    public function __construct(string $centerId, public string $runId, public int $sequence, public bool $fail = false)
    {
        parent::__construct($centerId);
    }

    public function handle(): void
    {
        Redis::setex("courses:platform-worker-proof:{$this->runId}:{$this->sequence}", 120, json_encode([
            'worker_pid' => getmypid(), 'tenant' => tenant('id'), 'connection' => DB::getDefaultConnection(),
        ]));
        if ($this->fail) {
            throw new RuntimeException('Intentional platform worker isolation probe failure.');
        }

        parent::handle();
    }
}
