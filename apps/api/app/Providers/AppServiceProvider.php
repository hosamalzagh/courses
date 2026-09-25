<?php

namespace App\Providers;

use Illuminate\Auth\Notifications\ResetPassword;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        Model::preventLazyLoading(! app()->isProduction());

        RateLimiter::for('center-route', function (Request $request): Limit {
            $attempts = $request->isMethod('GET') ? 20
                : ($request->is('api/v1/center/auth/forgot-password') ? 3 : 5);

            return Limit::perMinute($attempts)->by(implode('|', [
                $request->getHost(),
                $request->getMethod(),
                $request->route()->uri(),
                $request->user()?->getAuthIdentifier() ?? $request->ip(),
            ]));
        });

        ResetPassword::createUrlUsing(function ($user, string $token): string {
            return request()->getSchemeAndHttpHost().'/reset-password/'.$token
                .'?email='.rawurlencode($user->getEmailForPasswordReset());
        });
    }
}
