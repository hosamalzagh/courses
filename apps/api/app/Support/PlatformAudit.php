<?php

namespace App\Support;

use App\Models\Center;
use App\Models\User;
use Illuminate\Support\Facades\DB;

final class PlatformAudit
{
    public const FIELDS = [
        'name' => 'الاسم', 'email' => 'البريد الإلكتروني', 'plan' => 'الخطة',
        'suspended' => 'حالة الإيقاف', 'domain' => 'النطاق', 'platform_role' => 'الدور',
    ];

    /** @return array<string, array{before: mixed, after: mixed}> */
    public static function changes(array $before, array $after): array
    {
        $changes = [];
        foreach (array_intersect_key($after, self::FIELDS) as $field => $value) {
            $old = $before[$field] ?? null;
            if ($old !== $value) {
                $changes[$field] = ['before' => $old, 'after' => $value];
            }
        }

        return $changes;
    }

    public static function record(User $actor, ?Center $center, string $event, array $details = []): void
    {
        $safe = array_filter(array_intersect_key($details, array_flip([
            'domain', 'user_id', 'user_name', 'role', 'old_role', 'new_role',
        ])), fn ($value): bool => is_scalar($value) || $value === null);
        foreach (['fields', 'changed_fields'] as $key) {
            if (isset($details[$key]) && is_array($details[$key])) {
                $safe[$key] = array_values(array_intersect($details[$key], [...array_keys(self::FIELDS), 'password']));
            }
        }
        $changes = [];
        foreach (array_intersect_key($details['changes'] ?? [], self::FIELDS) as $field => $change) {
            if (is_array($change) && array_key_exists('before', $change) && array_key_exists('after', $change)
                && (is_scalar($change['before']) || $change['before'] === null)
                && (is_scalar($change['after']) || $change['after'] === null)) {
                $changes[$field] = ['before' => $change['before'], 'after' => $change['after']];
            }
        }
        $safe['changes'] = $changes;
        $safe['actor_name'] = $actor->name;
        $safe['center_name'] = $center?->name;

        DB::connection('central')->table('platform_audit_logs')->insert([
            'actor_id' => $actor->id, 'tenant_id' => $center?->id, 'event' => $event,
            'details' => json_encode($safe, JSON_THROW_ON_ERROR), 'created_at' => now(),
        ]);
    }
}
