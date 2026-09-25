<?php

namespace Tests\Feature;

use App\Mail\CenterInvitationMail;
use App\Models\User;
use Illuminate\Auth\Notifications\ResetPassword as ResetPasswordNotification;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Notification;
use PragmaRX\Google2FA\Google2FA;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class InvitationAuthenticationTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    public function test_first_owner_accepts_invitation_once_and_completes_mfa_before_center_access(): void
    {
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
        $this->postJson("http://alpha.courses.test/api/v1/center/invitations/{$token}", [
            'name' => 'First Owner', 'password' => 'correct-horse-battery-staple',
            'password_confirmation' => 'correct-horse-battery-staple',
        ])->assertStatus(410);

        $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', [
            'email' => 'owner@alpha.test', 'password' => 'correct-horse-battery-staple',
        ])->assertStatus(202)->assertJsonPath('status', 'mfa_setup_required');
        $this->getJson('http://alpha.courses.test/api/v1/center/user')->assertUnauthorized();

        $secret = $this->postJson('http://alpha.courses.test/api/v1/center/auth/mfa/setup')
            ->assertOk()->json('secret');
        $code = app(Google2FA::class)->getCurrentOtp($secret);
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/mfa/confirm', ['code' => $code])
            ->assertOk();
        $this->getJson('http://alpha.courses.test/api/v1/center/user')
            ->assertOk()->assertJsonPath('permissions.center_roles.0', 'center_owner');

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
    }
}
