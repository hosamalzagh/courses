<?php

namespace Tests\Feature;

use App\Mail\CenterInvitationMail;
use App\Models\Center;
use App\Models\CenterInvitation;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Auth\Notifications\ResetPassword as ResetPasswordNotification;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\Password;
use PragmaRX\Google2FA\Google2FA;
use RuntimeException;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class InvitationAuthenticationTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    public function test_first_owner_invitation_is_host_bound_single_use_and_within_read_budget(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        Mail::fake();
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform');
        foreach (['alpha', 'beta'] as $slug) {
            $this->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => ucfirst($slug), 'slug' => $slug, 'subdomain' => $slug,
                'plan' => 'starter', 'owner_email' => "owner@{$slug}.test",
            ])->assertCreated();
        }

        $alpha = Center::where('slug', 'alpha')->firstOrFail();
        $invitation = CenterInvitation::where('tenant_id', $alpha->id)->firstOrFail();
        $token = $invitation->token_ciphertext;
        $this->getJson("http://beta.courses.test/api/v1/center/invitations/{$token}")->assertStatus(410);
        $this->postJson("http://beta.courses.test/api/v1/center/invitations/{$token}", [
            'name' => 'Wrong Center', 'password' => 'correct-horse-battery-staple',
            'password_confirmation' => 'correct-horse-battery-staple',
        ])->assertStatus(410);

        $page = $this->getJson("http://alpha.courses.test/api/v1/center/invitations/{$token}")
            ->assertOk()->assertJsonPath('email', 'owner@alpha.test');
        $this->assertLessThanOrEqual(6, (int) $page->headers->get('X-Courses-Query-Count'));
        $invitation->update(['expires_at' => now()->subMinute()]);
        $this->getJson("http://alpha.courses.test/api/v1/center/invitations/{$token}")->assertStatus(410);
        $this->postJson("http://alpha.courses.test/api/v1/center/invitations/{$token}", [
            'name' => 'Expired Owner', 'password' => 'correct-horse-battery-staple',
            'password_confirmation' => 'correct-horse-battery-staple',
        ])->assertStatus(410);
        $this->assertSame(0, User::where('email', 'owner@alpha.test')->count());
        $this->assertSame(0, CenterMembership::where('tenant_id', $alpha->id)->count());
    }

    public function test_partial_acceptance_can_be_reconciled_and_retried_without_duplicate_identity(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        Mail::fake();
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')
            ->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha',
                'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
            ])->assertCreated();
        $center = Center::where('slug', 'alpha')->firstOrFail();
        $invitation = CenterInvitation::where('tenant_id', $center->id)->firstOrFail();
        $url = "http://alpha.courses.test/api/v1/center/invitations/{$invitation->token_ciphertext}";
        $payload = [
            'name' => 'First Owner', 'password' => 'correct-horse-battery-staple',
            'password_confirmation' => 'correct-horse-battery-staple',
        ];

        $failAudit = true;
        DB::connection('central')->listen(function ($query) use (&$failAudit): void {
            if ($failAudit && $query->connectionName === 'central'
                && str_contains(strtolower($query->sql), 'insert into "center_audit_outbox"')) {
                $failAudit = false;
                throw new RuntimeException('Simulated central commit failure');
            }
        });
        $this->postJson($url, $payload)->assertStatus(500);
        $this->assertSame(0, User::where('email', 'owner@alpha.test')->count());
        $this->assertSame(0, CenterMembership::where('tenant_id', $center->id)->count());
        $this->assertNull($invitation->fresh()->accepted_at);
        $this->assertSame(1, $center->run(fn () => DB::table('center_grants')->count()));

        $this->assertSame(0, Artisan::call('courses:reconcile-grants', ['slug' => 'alpha', '--apply' => true]));
        $this->assertSame(0, $center->run(fn () => DB::table('center_grants')->count()));
        $this->postJson($url, $payload)->assertOk();
        $owner = User::where('email', 'owner@alpha.test')->firstOrFail();
        $this->assertTrue($owner->hasVerifiedEmail());
        $this->assertSame(1, CenterMembership::where('tenant_id', $center->id)->where('user_id', $owner->id)->count());
        $this->assertSame(1, $center->run(fn () => DB::table('center_grants')->where('user_id', $owner->id)->where('role', 'center_owner')->count()));
        $this->postJson($url, $payload)->assertStatus(410);
    }

    public function test_first_owner_accepts_invitation_and_can_opt_in_to_mfa(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
        Mail::fake();
        $platformOwner = User::factory()->platformOwner()->create();
        $this->actingAs($platformOwner, 'platform')
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
        $this->assertSame(1, CenterMembership::where('tenant_id', $center->id)
            ->where('user_id', User::where('email', 'owner@alpha.test')->value('id'))->count());

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
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/reset-password', [
            'email' => 'owner@alpha.test', 'token' => $resetToken,
            'password' => 'another-correct-horse-battery-staple',
            'password_confirmation' => 'another-correct-horse-battery-staple',
        ])->assertUnprocessable()->assertJsonPath('code', 'invalid_reset_link');
        $this->assertTrue(Hash::check('new-correct-horse-battery-staple', $owner->fresh()->password));

        $expiredToken = Password::createToken($owner);
        $this->travel(61)->minutes();
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/reset-password', [
            'email' => 'owner@alpha.test', 'token' => $expiredToken,
            'password' => 'another-correct-horse-battery-staple',
            'password_confirmation' => 'another-correct-horse-battery-staple',
        ])->assertUnprocessable()->assertJsonPath('code', 'invalid_reset_link');
        $this->travelBack();

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
