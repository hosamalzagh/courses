<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class RequirePlatformMfa
{
    public function handle(Request $request, Closure $next): Response
    {
        abort_unless(in_array($request->user()?->platform_role, ['platform_owner', 'platform_support'], true)
            && $request->user()->getAppAuthenticationSecret(), 403);

        return $next($request);
    }
}
