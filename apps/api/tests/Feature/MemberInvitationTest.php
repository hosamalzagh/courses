<?php

namespace Tests\Feature;

use App\Mail\CenterInvitationMail;
use App\Models\Center;
use App\Models\CenterInvitation;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use RuntimeException;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class MemberInvitationTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    public function test_failed_member_mail_keeps_token_and_requires_delivery_resolution_before_retry(): void
    {
        Mail::fake();
        $this->actingAs(User::factory()->create(['platform_role' => 'platform_owner']))
            ->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha',
                'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
            ])->assertCreated();
        $alpha = Center::where('slug', 'alpha')->firstOrFail();
        $manager = User::factory()->create(['email_verified_at' => now()]);
        CenterMembership::create(['tenant_id' => $alpha->id, 'user_id' => $manager->id, 'status' => 'active']);
        $alpha->run(fn () => DB::table('center_grants')->insert([
            'user_id' => $manager->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
        ]));
        $this->actingAs($manager)->withSession(['center_id' => $alpha->id]);

        $mailManager = Mail::getFacadeRoot()->manager;
        Mail::shouldReceive('to')->once()->andThrow(new RuntimeException('Simulated uncertain SMTP delivery'));
        $url = 'http://alpha.courses.test/api/v1/center/members/invitations';
        $payload = ['email' => 'staff@courses.test'];
        $this->postJson($url, $payload)->assertStatus(409)->assertJsonPath('code', 'invitation_delivery_uncertain');
        $invitation = CenterInvitation::where('tenant_id', $alpha->id)->where('email', $payload['email'])->firstOrFail();
        $token = $invitation->token_ciphertext;
        $this->assertNotNull($invitation->delivery_claimed_at);
        $this->assertNull($invitation->sent_at);
        $this->getJson('http://alpha.courses.test/api/v1/center/member-workspace')
            ->assertOk()->assertJsonFragment(['email' => $payload['email'], 'status' => 'uncertain']);
        $this->postJson($url, $payload)->assertStatus(409)->assertJsonPath('code', 'invitation_delivery_uncertain');
        $this->assertSame($token, $invitation->fresh()->token_ciphertext);
        $this->assertSame(0, Artisan::call('courses:resolve-member-invitation', [
            'slug' => 'alpha', 'email' => $payload['email'], 'outcome' => 'not-delivered',
        ]));
        $this->getJson('http://alpha.courses.test/api/v1/center/member-workspace')
            ->assertOk()->assertJsonFragment(['email' => $payload['email'], 'status' => 'not_sent']);

        Mail::swap($mailManager);
        Mail::fake();
        $this->postJson($url, $payload)->assertCreated()->assertJsonPath('invitation.status', 'pending');
        Mail::assertSent(CenterInvitationMail::class, 1);
        $this->assertSame($token, $invitation->fresh()->token_ciphertext);
        $this->assertNotNull($invitation->fresh()->sent_at);
        $this->postJson($url, $payload)->assertOk()->assertJsonPath('status', 'already_sent');
        Mail::assertSent(CenterInvitationMail::class, 1);

        $adminPayload = [...$payload, 'center_role' => 'center_admin'];
        $this->postJson($url, $adminPayload)->assertOk()
            ->assertJsonPath('status', 'role_updated')
            ->assertJsonPath('invitation.center_role', 'center_admin');
        $this->assertSame('center_admin', $invitation->fresh()->center_role);
        $this->assertSame(1, DB::connection('central')->table('center_audit_outbox')
            ->where('tenant_id', $alpha->id)->where('event', 'member.invitation_role_changed')->count());
        Mail::assertSent(CenterInvitationMail::class, 1);
        $this->postJson($url, $adminPayload)->assertOk()->assertJsonPath('status', 'already_sent');

        $invitation->fresh()->update(['sent_at' => null]);
        $this->assertSame(0, Artisan::call('courses:resolve-member-invitation', [
            'slug' => 'alpha', 'email' => $payload['email'], 'outcome' => 'delivered',
        ]));
        $this->postJson($url, $payload)->assertOk();
        Mail::assertSent(CenterInvitationMail::class, 1);
        $invitation->update(['expires_at' => now()->subMinute()]);
        Mail::fake();
        $this->postJson($url, $payload)->assertCreated();
        Mail::assertSent(CenterInvitationMail::class, 1);
        $this->assertNotSame($token, $invitation->fresh()->token_ciphertext);
        $this->getJson("http://alpha.courses.test/api/v1/center/invitations/{$token}")->assertStatus(410);
    }

    public function test_ambiguous_legacy_email_does_not_attach_invitation_to_an_arbitrary_user(): void
    {
        Mail::fake();
        $this->actingAs(User::factory()->create(['platform_role' => 'platform_owner']))
            ->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha',
                'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
            ])->assertCreated();
        $alpha = Center::where('slug', 'alpha')->firstOrFail();
        $manager = User::factory()->create(['email_verified_at' => now()]);
        CenterMembership::create(['tenant_id' => $alpha->id, 'user_id' => $manager->id, 'status' => 'active']);
        $alpha->run(fn () => DB::table('center_grants')->insert([
            'user_id' => $manager->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
        ]));
        $first = User::factory()->create(['email' => 'duplicate@courses.test']);
        $second = User::factory()->create();
        DB::connection('central')->table('users')->where('id', $second->id)
            ->update(['email' => 'Duplicate@Courses.Test']);

        $this->actingAs($manager)->withSession(['center_id' => $alpha->id]);
        $this->postJson('http://alpha.courses.test/api/v1/center/members/invitations', [
            'email' => 'duplicate@courses.test',
        ])->assertCreated();
        $invitation = CenterInvitation::where('tenant_id', $alpha->id)
            ->where('email', 'duplicate@courses.test')->firstOrFail();
        $this->postJson("http://alpha.courses.test/api/v1/center/invitations/{$invitation->token_ciphertext}", [
            'name' => 'Duplicate', 'password' => 'correct-horse-battery-staple',
            'password_confirmation' => 'correct-horse-battery-staple',
        ])->assertStatus(409);
        $this->assertNull($invitation->fresh()->accepted_at);
        $this->assertFalse(CenterMembership::where('tenant_id', $alpha->id)
            ->whereIn('user_id', [$first->id, $second->id])->exists());
    }

    public function test_existing_user_accepts_one_use_invitations_in_two_centers_and_memberships_remain_independent(): void
    {
        Mail::fake();
        $this->actingAs(User::factory()->create(['platform_role' => 'platform_owner']));
        foreach (['alpha', 'beta'] as $slug) {
            $this->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => ucfirst($slug), 'slug' => $slug, 'subdomain' => $slug,
                'plan' => 'starter', 'owner_email' => "owner@{$slug}.test",
            ])->assertCreated();
        }
        $password = 'correct-horse-battery-staple';
        $shared = User::factory()->create([
            'email' => 'shared@courses.test', 'password' => $password, 'email_verified_at' => now(),
        ]);
        DB::connection('central')->table('users')->where('id', $shared->id)
            ->update(['email' => 'Shared@Courses.Test']);
        $originalUserCount = User::count();
        $centers = Center::query()->whereIn('slug', ['alpha', 'beta'])->get()->keyBy('slug');

        foreach (['alpha', 'beta'] as $slug) {
            $center = $centers[$slug];
            $manager = User::factory()->create(['email_verified_at' => now()]);
            CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $manager->id, 'status' => 'active']);
            $center->run(fn () => DB::table('center_grants')->insert([
                'user_id' => $manager->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
            ]));
            $this->actingAs($manager)->withSession(['center_id' => $center->id]);
            $this->postJson("http://{$slug}.courses.test/api/v1/center/members/invitations", [
                'email' => $shared->email,
            ])->assertCreated();
            Mail::assertSent(CenterInvitationMail::class, fn ($mail) => $mail->hasTo($shared->email));
            $invitation = CenterInvitation::where('tenant_id', $center->id)->where('email', $shared->email)->firstOrFail();
            $workspace = $this->getJson("http://{$slug}.courses.test/api/v1/center/member-workspace")->assertOk();
            $this->assertSame('pending', collect($workspace->json('invitations'))
                ->firstWhere('email', $shared->email)['status'] ?? null);
            $this->assertStringEndsWith('Z', collect($workspace->json('invitations'))
                ->firstWhere('email', $shared->email)['expires_at']);
            $this->assertLessThanOrEqual(6, (int) $workspace->headers->get('X-Courses-Query-Count'));
            $token = $invitation->token_ciphertext;
            $payload = ['name' => 'Shared Staff', 'password' => $password, 'password_confirmation' => $password];
            $this->postJson("http://{$slug}.courses.test/api/v1/center/invitations/{$token}", $payload)->assertOk();
            $this->postJson("http://{$slug}.courses.test/api/v1/center/invitations/{$token}", $payload)->assertStatus(410);
            $this->assertSame(1, CenterMembership::where('tenant_id', $center->id)->where('user_id', $shared->id)->count());
            $this->assertSame($shared->id, User::where('email', $shared->email)->value('id'));
            $acceptedWorkspace = $this->getJson("http://{$slug}.courses.test/api/v1/center/member-workspace")
                ->assertOk();
            $this->assertFalse(collect($acceptedWorkspace->json('invitations'))->contains('email', $shared->email));
        }

        $this->assertSame($originalUserCount + 2, User::count());
        $this->assertSame(1, User::whereRaw('LOWER(email) = ?', ['shared@courses.test'])->count());
        $this->assertSame(2, CenterMembership::where('user_id', $shared->id)->count());
        $alpha = $centers['alpha'];
        $beta = $centers['beta'];
        $alphaMembership = CenterMembership::where('tenant_id', $alpha->id)->where('user_id', $shared->id)->firstOrFail();
        $this->actingAs($shared)->withSession(['center_id' => $alpha->id]);
        $this->getJson('http://alpha.courses.test/api/v1/center/user')->assertOk();

        $alphaManager = User::whereKey(CenterMembership::where('tenant_id', $alpha->id)
            ->where('user_id', '!=', $shared->id)->value('user_id'))->firstOrFail();
        $this->actingAs($alphaManager)->withSession(['center_id' => $alpha->id]);
        $this->patchJson("http://alpha.courses.test/api/v1/center/members/{$alphaMembership->id}/status", [
            'status' => 'suspended',
        ])->assertOk();
        $this->actingAs($shared)->withSession(['center_id' => $alpha->id]);
        $this->getJson('http://alpha.courses.test/api/v1/center/user')
            ->assertForbidden()->assertJsonPath('code', 'membership_suspended');
        $this->withSession(['center_id' => $beta->id]);
        $this->getJson('http://beta.courses.test/api/v1/center/user')->assertOk();
        $this->actingAs($alphaManager)->withSession(['center_id' => $alpha->id]);
        $this->patchJson("http://alpha.courses.test/api/v1/center/members/{$alphaMembership->id}/status", [
            'status' => 'active',
        ])->assertOk();
        $this->actingAs($shared)->withSession(['center_id' => $alpha->id]);
        $this->getJson('http://alpha.courses.test/api/v1/center/user')->assertOk();
        $this->assertSame(2, DB::connection('central')->table('center_audit_outbox')
            ->where('tenant_id', $alpha->id)->where('event', 'member.status_changed')->count());

        $this->actingAs($alphaManager)->withSession(['center_id' => $alpha->id]);
        $this->postJson('http://alpha.courses.test/api/v1/center/members/invitations', [
            'email' => 'expired@courses.test',
        ])->assertCreated();
        CenterInvitation::where('tenant_id', $alpha->id)->where('email', 'expired@courses.test')
            ->update(['expires_at' => now()->subMinute()]);
        $workspace = $this->getJson('http://alpha.courses.test/api/v1/center/member-workspace')->assertOk();
        $this->assertSame('expired', collect($workspace->json('invitations'))
            ->firstWhere('email', 'expired@courses.test')['status'] ?? null);
    }
}
