<?php

namespace App\Http\Controllers;

use App\Support\CenterRecoveryCodes;
use Filament\Auth\MultiFactor\App\AppAuthentication;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\ValidationException;
use PragmaRX\Google2FA\Google2FA;

class CenterSecurityController extends Controller
{
    public function setup(Request $request, Google2FA $totp): JsonResponse
    {
        $data = $request->validate(['password' => ['required', 'string']]);
        $user = $request->user()->fresh();
        abort_if($user->getAppAuthenticationSecret(), 409);
        $this->requirePassword($data['password'], $user->password);

        $secret = $totp->generateSecretKey();
        $request->session()->put('center_mfa_enrollment', [
            'user_id' => $user->id,
            'center_id' => $request->attributes->get('center')->id,
            'secret' => $secret,
            'expires_at' => now()->addMinutes(10)->timestamp,
        ]);

        return response()->json([
            'secret' => $secret,
            'otpauth_url' => 'otpauth://totp/'.rawurlencode('Courses:'.$user->email)
                .'?secret='.$secret.'&issuer=Courses',
        ])->header('Cache-Control', 'private, no-store');
    }

    public function confirm(Request $request, Google2FA $totp): JsonResponse
    {
        $data = $request->validate(['code' => ['required', 'digits:6']]);
        $enrollment = $request->session()->get('center_mfa_enrollment');
        $user = $request->user()->fresh();
        abort_unless($enrollment
            && $enrollment['user_id'] === $user->id
            && $enrollment['center_id'] === $request->attributes->get('center')->id
            && $enrollment['expires_at'] > now()->timestamp, 410);
        abort_if($user->getAppAuthenticationSecret(), 409);
        abort_unless($totp->verifyKey($enrollment['secret'], $data['code']), 422);

        $recovery = AppAuthentication::make();
        $recoveryCodes = $recovery->generateRecoveryCodes();
        DB::connection('central')->transaction(function () use ($user, $enrollment, $recovery, $recoveryCodes): void {
            $user->saveAppAuthenticationSecret($enrollment['secret']);
            $recovery->saveRecoveryCodes($user, $recoveryCodes);
        });
        Auth::setUser($user);
        $request->session()->forget('center_mfa_enrollment');

        return response()->json([
            'status' => 'enabled', 'recovery_codes' => $recoveryCodes,
        ])->header('Cache-Control', 'private, no-store');
    }

    public function cancel(Request $request): JsonResponse
    {
        $request->session()->forget('center_mfa_enrollment');

        return response()->json(['status' => 'cancelled'])->header('Cache-Control', 'private, no-store');
    }

    public function disable(Request $request, Google2FA $totp): JsonResponse
    {
        $data = $request->validate([
            'password' => ['required', 'string'],
            'code' => ['nullable', 'required_without:recovery_code', 'digits:6'],
            'recovery_code' => ['nullable', 'required_without:code', 'string', 'max:100'],
        ]);
        $user = $request->user()->fresh();
        abort_if(in_array($user->platform_role, ['platform_owner', 'platform_support'], true), 403);
        $secret = $user->getAppAuthenticationSecret();
        abort_unless($secret, 409);
        $this->requirePassword($data['password'], $user->password);
        if (isset($data['recovery_code'])) {
            abort_unless(CenterRecoveryCodes::consume($user, $data['recovery_code']), 422);
        } else {
            abort_unless($totp->verifyKey($secret, $data['code']), 422);
        }

        $user->saveAppAuthenticationSecret(null);
        $user->saveAppAuthenticationRecoveryCodes(null);
        Auth::setUser($user);
        $request->session()->forget('center_mfa_enrollment');
        $request->session()->regenerate();

        return response()->json(['status' => 'disabled'])->header('Cache-Control', 'private, no-store');
    }

    private function requirePassword(string $plain, string $hash): void
    {
        if (! Hash::check($plain, $hash)) {
            throw ValidationException::withMessages(['password' => 'كلمة المرور غير صحيحة.']);
        }
    }
}
