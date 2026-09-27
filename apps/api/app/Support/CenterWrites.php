<?php

namespace App\Support;

use App\Models\Center;
use App\Models\CenterMembership;
use Closure;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class CenterWrites
{
    public static function run(Request $request, Closure $operation): JsonResponse
    {
        return DB::connection('central')->transaction(function () use ($request, $operation): JsonResponse {
            $centerId = $request->attributes->get('center')->id;
            $center = Center::query()->whereKey($centerId)->lockForUpdate()->firstOrFail();
            abort_if($center->suspended, 423);
            abort_unless($center->provisioning_status === 'active', 503);
            abort_unless(CenterMembership::query()->where('tenant_id', $centerId)->where('user_id', $request->user()->id)->value('status') === 'active', 403);

            return DB::connection('tenant')->transaction(fn (): JsonResponse => $operation(CenterPermissions::forUser($request->user()->id)));
        });
    }
}
