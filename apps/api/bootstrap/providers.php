<?php

use App\Providers\AppServiceProvider;
use App\Providers\Filament\AdminPanelProvider;
use App\Providers\HorizonServiceProvider;
use App\Providers\TelescopeServiceProvider;
use App\Providers\TenancyServiceProvider;
use Laravel\Telescope\Telescope;

return [
    AppServiceProvider::class,
    AdminPanelProvider::class,
    HorizonServiceProvider::class,
    ...(class_exists(Telescope::class) ? [TelescopeServiceProvider::class] : []),
    TenancyServiceProvider::class,
];
