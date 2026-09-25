<?php

namespace App\Providers;

use App\Models\User;
use Illuminate\Support\Facades\Gate;
use Laravel\Telescope\IncomingEntry;
use Laravel\Telescope\Telescope;
use Laravel\Telescope\TelescopeApplicationServiceProvider;

class TelescopeServiceProvider extends TelescopeApplicationServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        // Telescope::night();

        $this->hideSensitiveRequestDetails();

        $isLocal = $this->app->environment('local');

        Telescope::filter(function (IncomingEntry $entry) use ($isLocal) {
            return $isLocal ||
                   $entry->isReportableException() ||
                   $entry->isFailedRequest() ||
                   $entry->isFailedJob() ||
                   $entry->isScheduledTask() ||
                   $entry->hasMonitoredTag();
        });

        Telescope::filterBatch(function (): bool {
            if (app()->runningInConsole()) {
                return false;
            }

            $request = request();
            if ($request->is(
                'livewire/*',
                'admin/login',
                'api/v1/center/invitations/*',
                'api/v1/center/auth/*',
                'api/v1/center/security/*',
            )) {
                return false;
            }

            return ! ($request->isMethod('POST') && $request->is(
                'api/v1/platform/centers',
                'api/v1/platform/centers/*/retry',
                'api/v1/center/members/invitations',
            ));
        });
    }

    /**
     * Prevent sensitive request details from being logged by Telescope.
     */
    protected function hideSensitiveRequestDetails(): void
    {
        Telescope::hideRequestParameters(['_token', 'password', 'password_confirmation', 'code', 'recovery_code', 'token']);

        Telescope::hideRequestHeaders([
            'cookie',
            'x-csrf-token',
            'x-xsrf-token',
            'authorization',
        ]);
    }

    /**
     * Register the Telescope gate.
     *
     * This gate determines who can access Telescope in non-local environments.
     */
    protected function gate(): void
    {
        Gate::define('viewTelescope', function (User $user) {
            return $user->platform_role === 'platform_owner';
        });
    }

    protected function authorization(): void
    {
        $this->gate();

        Telescope::auth(fn ($request) => $request->getHost() === config('courses.platform_host')
            && $request->user()?->platform_role === 'platform_owner');
    }
}
