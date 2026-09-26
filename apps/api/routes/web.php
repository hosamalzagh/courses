<?php

use App\Http\Controllers\PlatformCenterController;
use App\Http\Middleware\RequirePlatformMfa;
use Illuminate\Support\Facades\Route;

Route::domain(config('courses.platform_host'))->group(function (): void {
    Route::get('/', fn () => redirect('/admin'));

    Route::middleware(['auth:platform', RequirePlatformMfa::class])->prefix('api/v1/platform')->group(function (): void {
        Route::get('centers', [PlatformCenterController::class, 'index']);
        Route::post('centers', [PlatformCenterController::class, 'store']);
        Route::get('centers/{center}', [PlatformCenterController::class, 'show']);
        Route::patch('centers/{center}', [PlatformCenterController::class, 'update']);
        Route::post('centers/{center}/retry', [PlatformCenterController::class, 'retry']);
        Route::put('centers/{center}/domain', [PlatformCenterController::class, 'changeDomain']);
    });
});
