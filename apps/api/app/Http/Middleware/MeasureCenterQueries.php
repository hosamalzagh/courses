<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\Response;

class MeasureCenterQueries
{
    private static ?Dispatcher $listenerDispatcher = null;

    /**
     * Handle an incoming request.
     *
     * @param  Closure(Request): (Response)  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        if (! app()->isLocal() && ! app()->runningUnitTests()) {
            return $next($request);
        }

        $dispatcher = DB::connection()->getEventDispatcher();
        if (self::$listenerDispatcher !== $dispatcher) {
            DB::listen(function (QueryExecuted $query): void {
                $meter = request()->attributes->get('courses_query_meter');
                if (! $meter) {
                    return;
                }
                $connection = $query->connectionName;
                $meter->counts[$connection] = ($meter->counts[$connection] ?? 0) + 1;
                $meter->duration += $query->time;
                $fingerprint = $connection.':'.$query->sql;
                $meter->repeated[$fingerprint] = ($meter->repeated[$fingerprint] ?? 0) + 1;
            });
            self::$listenerDispatcher = $dispatcher;
        }

        $meter = (object) ['counts' => [], 'duration' => 0.0, 'repeated' => []];
        $request->attributes->set('courses_query_meter', $meter);

        $response = $next($request);
        $request->attributes->remove('courses_query_meter');
        $total = array_sum($meter->counts);
        $response->headers->set('X-Courses-Query-Count', (string) $total);
        $response->headers->set('X-Courses-Sql-Ms', (string) round($meter->duration, 2));
        if ($request->isMethod('GET') && $total > 6) {
            Log::warning('Page read exceeded six queries', [
                'path' => $request->path(), 'counts' => $meter->counts, 'sql_ms' => round($meter->duration, 2),
                'duplicate_patterns' => count(array_filter($meter->repeated, fn ($count) => $count > 1)),
            ]);
        }

        return $response;
    }
}
