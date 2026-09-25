<?php

namespace App\Support;

use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

class CenterRecoveryCodes
{
    public static function consume(User $user, string $code): bool
    {
        return DB::connection('central')->transaction(function () use ($user, $code): bool {
            $locked = User::query()->whereKey($user->id)->lockForUpdate()->firstOrFail();
            $remaining = [];
            $matched = false;

            foreach ($locked->getAppAuthenticationRecoveryCodes() ?? [] as $hash) {
                if (! $matched && Hash::check($code, $hash)) {
                    $matched = true;

                    continue;
                }

                $remaining[] = $hash;
            }

            if ($matched) {
                $locked->saveAppAuthenticationRecoveryCodes($remaining);
            }

            return $matched;
        });
    }
}
