<?php

namespace App\Http\Middleware;

use App\Models\CenterMembership;
use App\Support\CenterPermissions;
use Closure;
use Illuminate\Database\QueryException;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class RequireCenterMember
{
    public function handle(Request $request, Closure $next): Response
    {
        $center = $request->attributes->get('center');
        $user = $request->user();

        abort_unless($user && $request->session()->get('center_id') === $center->id, 401);
        abort_unless($user->hasVerifiedEmail(), 403, 'Email verification is required.');

        $membership = CenterMembership::query()
            ->where('tenant_id', $center->id)
            ->where('user_id', $user->id)
            ->first();

        abort_unless($membership, 401);
        if ($membership->status !== 'active') {
            return response()->json(['code' => 'membership_suspended'], 403);
        }

        $request->attributes->set('center_membership', $membership);
        try {
            $request->attributes->set('center_permissions', CenterPermissions::forUser($user->id));
        } catch (QueryException $exception) {
            report($exception);
            abort(503, 'Center database is unavailable.');
        }

        return $next($request);
    }
}
