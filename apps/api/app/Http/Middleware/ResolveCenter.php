<?php

namespace App\Http\Middleware;

use App\Models\Center;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class ResolveCenter
{
    public function handle(Request $request, Closure $next): Response
    {
        $host = strtolower($request->getHost());
        $suffix = '.'.config('courses.base_domain');

        abort_unless(str_ends_with($host, $suffix), 404);
        abort_if($host === config('courses.platform_host'), 404);

        $subdomain = substr($host, 0, -strlen($suffix));
        abort_unless(preg_match('/^[a-z][a-z0-9-]{1,62}$/', $subdomain), 404);

        $center = Center::query()
            ->join('domains', 'domains.tenant_id', '=', 'tenants.id')
            ->where('domains.domain', $host)
            ->select('tenants.*')
            ->first();

        abort_unless($center, 404);
        abort_if($center->suspended, 423, 'Center is suspended.');
        abort_unless($center->provisioning_status === 'active', 503, 'Center is unavailable.');

        tenancy()->initialize($center);
        $request->attributes->set('center', $center);

        try {
            return $next($request);
        } finally {
            tenancy()->end();
        }
    }
}
