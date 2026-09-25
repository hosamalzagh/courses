<?php

use App\Http\Controllers\CenterAuditController;
use App\Http\Controllers\CenterAuthController;
use App\Http\Controllers\CenterBranchController;
use App\Http\Controllers\CenterMemberController;
use App\Http\Controllers\CenterSecurityController;
use App\Http\Controllers\CenterSettingsController;
use App\Http\Middleware\MeasureCenterQueries;
use App\Http\Middleware\RequireCenterMember;
use App\Http\Middleware\ResolveCenter;
use App\Models\Branch;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;

Route::middleware(['web', MeasureCenterQueries::class, ResolveCenter::class])->prefix('api/v1/center')->group(function (): void {
    Route::get('invitations/{token}', [CenterAuthController::class, 'invitation'])->middleware('throttle:center-route');
    Route::post('invitations/{token}', [CenterAuthController::class, 'acceptInvitation'])->middleware('throttle:center-route');
    Route::post('auth/login', [CenterAuthController::class, 'login'])->middleware('throttle:center-route');
    Route::post('auth/mfa/challenge', [CenterAuthController::class, 'mfaChallenge'])->middleware('throttle:center-route');
    Route::post('auth/logout', [CenterAuthController::class, 'logout']);
    Route::post('auth/forgot-password', [CenterAuthController::class, 'forgotPassword'])->middleware('throttle:center-route');
    Route::post('auth/reset-password', [CenterAuthController::class, 'resetPassword'])->middleware('throttle:center-route');
    Route::middleware(RequireCenterMember::class)->group(function (): void {
        Route::get('user', function (Request $request) {
            $permissions = $request->attributes->get('center_permissions');
            $branches = Branch::query()->orderBy('name');

            if (! $permissions->isCenterManager()) {
                $branches->whereIn('id', array_keys($permissions->branchRoles));
            }

            $payload = [
                'user' => [
                    ...$request->user()->only(['id', 'name', 'email']),
                    'permissions' => $permissions->toArray(),
                    'mfa_enabled' => (bool) $request->user()->getAppAuthenticationSecret(),
                    'mfa_required_for_platform' => in_array($request->user()->platform_role, ['platform_owner', 'platform_support'], true),
                ],
                'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
                'permissions' => $permissions->toArray(),
                'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
                'branches' => $branches->get(['id', 'name', 'slug', 'address']),
            ];

            if ($request->query('include') === 'settings' && $permissions->isCenterManager()) {
                $payload['settings'] = DB::connection('tenant')->table('center_settings')->where('id', 1)
                    ->first(['contact_email', 'phone', 'address']) ?: [
                        'contact_email' => null, 'phone' => null, 'address' => null,
                    ];
            }

            if ($request->query('include') === 'audit') {
                $payload['audit_entries'] = CenterAuditController::visibleEntries($request);
            }

            return response()->json($payload)->header('Cache-Control', 'private, no-store');
        });

        Route::get('branches', [CenterBranchController::class, 'index']);
        Route::post('branches', [CenterBranchController::class, 'store']);
        Route::get('branches/{branchId}', [CenterBranchController::class, 'show']);
        Route::patch('branches/{branchId}', [CenterBranchController::class, 'update']);
        Route::get('branches/{branchId}/audit', [CenterBranchController::class, 'auditLog']);
        Route::get('members', [CenterMemberController::class, 'index']);
        Route::get('member-workspace', [CenterMemberController::class, 'workspace']);
        Route::post('members/invitations', [CenterMemberController::class, 'invite']);
        Route::patch('members/{membership}/status', [CenterMemberController::class, 'updateStatus']);
        Route::put('members/{membership}/grants', [CenterMemberController::class, 'updateGrants']);
        Route::get('settings', [CenterSettingsController::class, 'show']);
        Route::patch('settings', [CenterSettingsController::class, 'update']);
        Route::get('audit', [CenterAuditController::class, 'index']);
        Route::post('security/mfa/setup', [CenterSecurityController::class, 'setup'])->middleware('throttle:center-route');
        Route::post('security/mfa/confirm', [CenterSecurityController::class, 'confirm'])->middleware('throttle:center-route');
        Route::post('security/mfa/cancel', [CenterSecurityController::class, 'cancel'])->middleware('throttle:center-route');
        Route::post('security/mfa/disable', [CenterSecurityController::class, 'disable'])->middleware('throttle:center-route');
    });
});
