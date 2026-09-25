<?php

namespace App\Console\Commands;

use App\Support\CenterAuditDelivery;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Throwable;

#[Signature('courses:deliver-center-audit {--limit=100}')]
#[Description('Retry pending center audit entries from the central outbox')]
class DeliverCenterAudit extends Command
{
    public function handle(): int
    {
        $limit = max(1, min(1000, (int) $this->option('limit')));
        $ids = DB::connection('central')->table('center_audit_outbox')
            ->whereNull('delivered_at')
            ->where(fn ($query) => $query->whereNull('next_attempt_at')->orWhere('next_attempt_at', '<=', now()))
            ->orderBy('id')->limit($limit)->pluck('id');
        $failed = 0;
        foreach ($ids as $id) {
            try {
                CenterAuditDelivery::deliver((int) $id);
            } catch (Throwable $exception) {
                report($exception);
                DB::connection('central')->table('center_audit_outbox')->where('id', $id)
                    ->whereNull('delivered_at')->update(['next_attempt_at' => now()->addMinutes(5)]);
                $failed++;
            }
        }
        $this->info('Attempted '.$ids->count().' center audit deliveries; failed: '.$failed);

        return $failed === 0 ? self::SUCCESS : self::FAILURE;
    }
}
