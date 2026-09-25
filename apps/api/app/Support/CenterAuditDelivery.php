<?php

namespace App\Support;

use App\Models\Center;
use Illuminate\Support\Facades\DB;
use Throwable;

class CenterAuditDelivery
{
    public static function record(string $centerId, ?int $actorId, string $event, array $details): int
    {
        return DB::connection('central')->table('center_audit_outbox')->insertGetId([
            'tenant_id' => $centerId,
            'actor_id' => $actorId,
            'event' => $event,
            'details' => json_encode($details),
            'created_at' => now(),
        ]);
    }

    public static function deliver(int $id, bool $replay = false): void
    {
        $entry = DB::connection('central')->table('center_audit_outbox')->where('id', $id)->first();
        if (! $entry || ($entry->delivered_at && ! $replay)) {
            return;
        }

        $center = Center::findOrFail($entry->tenant_id);
        $previousCenter = tenant();
        try {
            tenancy()->initialize($center);
            DB::connection('tenant')->transaction(function () use ($entry): void {
                DB::connection('tenant')->table('center_audit_logs')->insertOrIgnore([
                    'source_event_id' => $entry->id,
                    'actor_id' => $entry->actor_id,
                    'event' => $entry->event,
                    'details' => $entry->details,
                    'created_at' => $entry->created_at,
                ]);
            });
        } finally {
            if ($previousCenter) {
                tenancy()->initialize($previousCenter);
            } else {
                tenancy()->end();
            }
        }
        DB::connection('central')->table('center_audit_outbox')->where('id', $id)
            ->whereNull('delivered_at')->update(['delivered_at' => now()]);
    }

    public static function replayForCenter(string $centerId): void
    {
        DB::connection('central')->table('center_audit_outbox')->where('tenant_id', $centerId)
            ->orderBy('id')->chunkById(100, function ($entries): void {
                foreach ($entries as $entry) {
                    self::deliver((int) $entry->id, true);
                }
            });
    }

    public static function tryDeliver(int $id): bool
    {
        try {
            self::deliver($id);

            return true;
        } catch (Throwable $exception) {
            report($exception);

            return false;
        }
    }
}
