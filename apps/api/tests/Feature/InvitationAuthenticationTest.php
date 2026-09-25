<?php

namespace Tests\Feature;

use App\Mail\CenterInvitationMail;
use App\Models\Center;
use App\Models\User;
use Illuminate\Auth\Notifications\ResetPassword as ResetPasswordNotification;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Notification;
use PragmaRX\Google2FA\Google2FA;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class InvitationAuthenticationTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    public function test_first_owner_accepts_invitation_and_can_opt_in_to_mfa(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        Mail::fake();
        $platformOwner = User::factory()->create(['platform_role' => 'platform_owner']);
        $this->actingAs($platformOwner)
            ->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha',
                'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
            ])->assertCreated();

        $invitationUrl = null;
        Mail::assertSent(CenterInvitationMail::class, function (CenterInvitationMail $mail) use (&$invitationUrl): bool {
            $invitationUrl = $mail->acceptUrl;

            return $mail->hasTo('owner@alpha.test');
        });
        $token = basename(parse_url($invitationUrl, PHP_URL_PATH));
        $this->postJson("http://alpha.courses.test/api/v1/center/invitations/{$token}", [
            'name' => 'First Owner', 'password' => 'correct-horse-battery-staple',
            'password_confirmation' => 'correct-horse-battery-staple',
        ])->assertOk();
        $this->assertTrue(User::where('email', 'owner@alpha.test')->firstOrFail()->hasVerifiedEmail());
        $center = Center::where('slug', 'alpha')->firstOrFail();
        $acceptedAudit = DB::connection('central')->table('center_audit_outbox')
            ->where('tenant_id', $center->id)->where('event', 'invitation.accepted')->first();
        $this->assertNotNull($acceptedAudit?->delivered_at);
        $this->assertSame(1, $center->run(fn () => DB::table('center_audit_logs')
            ->where('source_event_id', $acceptedAudit->id)->count()));
        $this->postJson("http://alpha.courses.test/api/v1/center/invitations/{$token}", [
            'name' => 'First Owner', 'password' => 'correct-horse-battery-staple',
            'password_confirmation' => 'correct-horse-battery-staple',
        ])->assertStatus(410);

        $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', [
            'email' => 'owner@alpha.test', 'password' => 'correct-horse-battery-staple',
        ])->assertOk()->assertJsonPath('status', 'authenticated');
        $this->getJson('http://alpha.courses.test/api/v1/center/user')
            ->assertOk()->assertJsonPath('user.mfa_enabled', false);

        $this->postJson('http://alpha.courses.test/api/v1/center/security/mfa/setup', [
            'password' => 'incorrect-password',
        ])->assertUnprocessable();
        $secret = $this->postJson('http://alpha.courses.test/api/v1/center/security/mfa/setup', [
            'password' => 'correct-horse-battery-staple',
        ])
            ->assertOk()->json('secret');
        $code = app(Google2FA::class)->getCurrentOtp($secret);
        $recoveryCodes = $this->postJson('http://alpha.courses.test/api/v1/center/security/mfa/confirm', ['code' => $code])
            ->assertOk()->json('recovery_codes');
        $this->assertCount(8, $recoveryCodes);
        $this->getJson('http://alpha.courses.test/api/v1/center/user')
            ->assertOk()->assertJsonPath('permissions.center_roles.0', 'center_owner')
            ->assertJsonPath('user.mfa_enabled', true);

        $this->postJson('http://alpha.courses.test/api/v1/center/auth/logout')->assertOk();
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', [
            'email' => 'owner@alpha.test', 'password' => 'correct-horse-battery-staple',
        ])->assertStatus(202)->assertJsonPath('status', 'mfa_challenge_required');
        $this->getJson('http://alpha.courses.test/api/v1/center/user')->assertUnauthorized();
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/mfa/challenge', [
            'recovery_code' => $recoveryCodes[0],
        ])->assertOk();
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/logout')->assertOk();
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', [
            'email' => 'owner@alpha.test', 'password' => 'correct-horse-battery-staple',
        ])->assertStatus(202);
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/mfa/challenge', [
            'recovery_code' => $recoveryCodes[0],
        ])->assertUnprocessable();
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/mfa/challenge', ['code' => $code])
            ->assertOk();
        $this->postJson('http://alpha.courses.test/api/v1/center/security/mfa/disable', [
            'password' => 'correct-horse-battery-staple', 'recovery_code' => $recoveryCodes[1],
        ])->assertOk();
        $this->getJson('http://alpha.courses.test/api/v1/center/user')
            ->assertOk()->assertJsonPath('user.mfa_enabled', false);

        $this->assertSame(1, User::where('email', 'owner@alpha.test')->count());

        Notification::fake();
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/forgot-password', [
            'email' => 'owner@alpha.test',
        ])->assertOk();
        $resetToken = null;
        $owner = User::where('email', 'owner@alpha.test')->firstOrFail();
        Notification::assertSentTo($owner, ResetPasswordNotification::class,
            function (ResetPasswordNotification $notification) use (&$resetToken): bool {
                $resetToken = $notification->token;

                return true;
            });
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/reset-password', [
            'email' => 'owner@alpha.test', 'token' => $resetToken,
            'password' => 'new-correct-horse-battery-staple',
            'password_confirmation' => 'new-correct-horse-battery-staple',
        ])->assertOk();
        $this->assertTrue(Hash::check('new-correct-horse-battery-staple', $owner->fresh()->password));

        $owner->forceFill(['platform_role' => 'platform_owner'])->save();
        $platformSecret = $this->postJson('http://alpha.courses.test/api/v1/center/security/mfa/setup', [
            'password' => 'new-correct-horse-battery-staple',
        ])->assertOk()->json('secret');
        $platformCode = app(Google2FA::class)->getCurrentOtp($platformSecret);
        $this->postJson('http://alpha.courses.test/api/v1/center/security/mfa/confirm', [
            'code' => $platformCode,
        ])->assertOk();
        $this->postJson('http://alpha.courses.test/api/v1/center/security/mfa/disable', [
            'password' => 'new-correct-horse-battery-staple', 'code' => $platformCode,
        ])->assertForbidden();
    }
}
