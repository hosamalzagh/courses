<?php

namespace App\Http\Controllers;

use App\Models\CenterInvitation;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Password;
use Illuminate\Support\Str;
use Illuminate\Validation\Rules\Password as PasswordRule;
use Illuminate\Validation\ValidationException;
use PragmaRX\Google2FA\Google2FA;

class CenterAuthController extends Controller
{
    public function invitation(Request $request, string $token): JsonResponse
    {
        $invitation = $this->validInvitation($request, $token);

        return response()->json([
            'email' => $invitation->email,
            'center' => $request->attributes->get('center')->only(['name', 'slug']),
        ]);
    }

    public function acceptInvitation(Request $request, string $token): JsonResponse
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'password' => ['required', 'confirmed', PasswordRule::min(12)],
        ]);
        $center = $request->attributes->get('center');

        DB::connection('central')->transaction(function () use ($token, $data, $center): void {
            $invitation = CenterInvitation::where('tenant_id', $center->id)
                ->where('token_hash', hash('sha256', $token))
                ->lockForUpdate()
                ->first();

            abort_unless($invitation && ! $invitation->accepted_at && $invitation->expires_at->isFuture(), 410);

            $user = User::where('email', $invitation->email)->first();

            if ($user) {
                abort_unless(Hash::check($data['password'], $user->password), 422, 'Existing account password is incorrect.');
            } else {
                $user = User::create([
                    'name' => $data['name'],
                    'email' => $invitation->email,
                    'password' => $data['password'],
                ]);
            }

            // The one-use invitation is delivered to this exact mailbox.
            if (! $user->hasVerifiedEmail()) {
                $user->markEmailAsVerified();
            }

            CenterMembership::updateOrCreate(
                ['user_id' => $user->id, 'tenant_id' => $center->id],
                ['status' => 'active'],
            );

            if ($invitation->center_role) {
                DB::connection('tenant')->table('center_grants')->updateOrInsert(
                    ['user_id' => $user->id, 'role' => $invitation->center_role],
                    ['created_at' => now(), 'updated_at' => now()],
                );
            }

            $invitation->update(['accepted_at' => now()]);

            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $user->id,
                'event' => 'invitation.accepted',
                'details' => json_encode(['email' => $invitation->email]),
                'created_at' => now(),
            ]);
        });

        return response()->json(['status' => 'accepted']);
    }

    public function login(Request $request): JsonResponse
    {
        $data = $request->validate([
            'email' => ['required', 'email'],
            'password' => ['required', 'string'],
        ]);
        $email = strtolower($data['email']);
        $credentials = ['email' => $email, 'password' => $data['password']];

        Auth::logout();

        if (! Auth::validate($credentials)) {
            throw ValidationException::withMessages(['email' => 'Invalid credentials.']);
        }

        $user = User::where('email', $email)->firstOrFail();
        $center = $request->attributes->get('center');
        $membership = CenterMembership::where('user_id', $user->id)
            ->where('tenant_id', $center->id)
            ->where('status', 'active')
            ->first();

        abort_unless($membership && $user->hasVerifiedEmail(), 403);

        $isOwner = DB::connection('tenant')->table('center_grants')
            ->where('user_id', $user->id)
            ->where('role', 'center_owner')
            ->exists();

        $request->session()->invalidate();
        $request->session()->regenerateToken();

        if ($isOwner) {
            $request->session()->put('pending_center_login', ['user_id' => $user->id, 'center_id' => $center->id]);

            return response()->json([
                'status' => $user->getAppAuthenticationSecret() ? 'mfa_challenge_required' : 'mfa_setup_required',
            ], 202);
        }

        $this->finishLogin($request, $user);

        return response()->json(['status' => 'authenticated']);
    }

    public function mfaSetup(Request $request, Google2FA $totp): JsonResponse
    {
        $user = $this->pendingUser($request);
        abort_if($user->getAppAuthenticationSecret(), 409);

        $secret = $request->session()->get('pending_center_mfa_secret') ?: $totp->generateSecretKey();
        $request->session()->put('pending_center_mfa_secret', $secret);

        return response()->json([
            'secret' => $secret,
            'otpauth_url' => 'otpauth://totp/'.rawurlencode('Courses:'.$user->email)
                .'?secret='.$secret.'&issuer=Courses',
        ])->header('Cache-Control', 'no-store');
    }

    public function mfaConfirm(Request $request, Google2FA $totp): JsonResponse
    {
        $data = $request->validate(['code' => ['required', 'digits:6']]);
        $user = $this->pendingUser($request);
        abort_if($user->getAppAuthenticationSecret(), 409);
        $secret = $request->session()->get('pending_center_mfa_secret');
        abort_unless($secret && $totp->verifyKey($secret, $data['code']), 422);

        $user->saveAppAuthenticationSecret($secret);
        $this->finishLogin($request, $user);

        return response()->json(['status' => 'authenticated']);
    }

    public function mfaChallenge(Request $request, Google2FA $totp): JsonResponse
    {
        $data = $request->validate(['code' => ['required', 'digits:6']]);
        $user = $this->pendingUser($request);
        $secret = $user->getAppAuthenticationSecret();
        abort_unless($secret && $totp->verifyKey($secret, $data['code']), 422);

        $key = 'mfa-used:'.$request->attributes->get('center')->id.':'.$user->id.':'.$data['code'];
        abort_unless(Cache::add($key, true, 90), 422);

        $this->finishLogin($request, $user);

        return response()->json(['status' => 'authenticated']);
    }

    public function logout(Request $request): JsonResponse
    {
        Auth::logout();
        $request->session()->invalidate();
        $request->session()->regenerateToken();

        return response()->json(['status' => 'signed_out']);
    }

    public function forgotPassword(Request $request): JsonResponse
    {
        $data = $request->validate(['email' => ['required', 'email']]);
        $email = strtolower($data['email']);
        $user = User::query()->where('email', $email)->first();
        if ($user && CenterMembership::query()->where('user_id', $user->id)
            ->where('tenant_id', $request->attributes->get('center')->id)->where('status', 'active')->exists()) {
            Password::sendResetLink(['email' => $email]);
        }

        return response()->json(['status' => 'If the account exists, a reset email has been sent.']);
    }

    public function resetPassword(Request $request): JsonResponse
    {
        $data = $request->validate([
            'email' => ['required', 'email'],
            'token' => ['required', 'string'],
            'password' => ['required', 'confirmed', PasswordRule::min(12)],
        ]);

        $user = User::query()->where('email', strtolower($data['email']))->first();
        abort_unless($user && CenterMembership::query()->where('user_id', $user->id)
            ->where('tenant_id', $request->attributes->get('center')->id)->where('status', 'active')->exists(), 422);

        $status = Password::reset($data, function (User $user, string $password): void {
            $user->password = $password;
            $user->setRememberToken(Str::random(60));
            $user->save();
        });

        abort_unless($status === Password::PASSWORD_RESET, 422);

        return response()->json(['status' => 'password_reset']);
    }

    private function validInvitation(Request $request, string $token): CenterInvitation
    {
        $invitation = CenterInvitation::where('tenant_id', $request->attributes->get('center')->id)
            ->where('token_hash', hash('sha256', $token))
            ->first();

        abort_unless($invitation && ! $invitation->accepted_at && $invitation->expires_at->isFuture(), 410);

        return $invitation;
    }

    private function pendingUser(Request $request): User
    {
        $pending = $request->session()->get('pending_center_login');
        abort_unless($pending && $pending['center_id'] === $request->attributes->get('center')->id, 401);

        return User::findOrFail($pending['user_id']);
    }

    private function finishLogin(Request $request, User $user): void
    {
        Auth::login($user);
        $request->session()->regenerate();
        $request->session()->forget(['pending_center_login', 'pending_center_mfa_secret']);
        $request->session()->put('center_id', $request->attributes->get('center')->id);
    }
}
