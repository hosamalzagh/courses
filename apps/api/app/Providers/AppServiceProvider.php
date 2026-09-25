<?php

namespace App\Providers;

use Illuminate\Auth\Notifications\ResetPassword;
use Illuminate\Database\Eloquent\Model;
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

        ResetPassword::createUrlUsing(function ($user, string $token): string {
            return request()->getSchemeAndHttpHost().'/reset-password/'.$token
                .'?email='.rawurlencode($user->getEmailForPasswordReset());
        });
    }
}
