<?php

namespace Tests\Feature;

use App\Mail\CenterInvitationMail;
use App\Models\Center;
use App\Models\CenterInvitation;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class PlatformOwnerBootstrapTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    public function test_fresh_local_bootstrap_provisions_two_real_centers_without_duplicate_owners_or_invitations(): void
    {
        Storage::fake('local');
        Mail::fake();
        $this->artisan('courses:bootstrap-local')->assertSuccessful();
        $this->artisan('courses:bootstrap-local')->assertSuccessful();

        $this->assertSame(1, User::count());
        $this->assertSame(2, Center::count());
        $this->assertSame(2, CenterInvitation::count());
        $centers = Center::orderBy('slug')->get();
        $this->assertSame(['alpha', 'beta'], $centers->pluck('slug')->all());
        $this->assertNotSame($centers[0]->database()->getName(), $centers[1]->database()->getName());
        foreach ($centers as $center) {
            $this->assertSame('active', $center->provisioning_status);
            $this->assertNotNull($center->migration_version);
            $this->assertSame($center->slug.'.courses.test', $center->domains()->first()->domain);
            Mail::assertSent(CenterInvitationMail::class, fn ($mail) => $mail->hasTo($center->owner_email));
        }
        Mail::assertSentCount(2);
    }

    public function test_local_owner_can_be_created_without_demo_centers_or_committed_credentials(): void
    {
        Storage::fake('local');

        $this->artisan('courses:bootstrap-local', [
            '--email' => 'first-owner@example.test',
            '--without-centers' => true,
        ])->assertSuccessful();

        $owner = User::where('email', 'first-owner@example.test')->firstOrFail();
        $credentials = Storage::disk('local')->get('local-platform-credentials.txt');

        $this->assertSame('platform_owner', $owner->platform_role);
        $this->assertSame(0, Center::count());
        $this->assertMatchesRegularExpression('/Password: (\S+)/', $credentials);
        preg_match('/Password: (\S+)/', $credentials, $match);
        $this->assertTrue(Hash::check($match[1], $owner->password));
        $this->assertSame('0600', substr(sprintf('%o', fileperms(Storage::disk('local')->path('local-platform-credentials.txt'))), -4));

        $this->artisan('courses:bootstrap-local', [
            '--email' => 'first-owner@example.test',
            '--without-centers' => true,
        ])->assertSuccessful();

        $this->assertSame($owner->password, $owner->fresh()->password);
    }

    public function test_bootstrap_refuses_to_promote_an_existing_center_account(): void
    {
        Storage::fake('local');
        $user = User::factory()->create(['email' => 'member@example.test']);

        $this->artisan('courses:bootstrap-local', [
            '--email' => $user->email,
            '--without-centers' => true,
        ])->assertFailed();

        $this->assertNull($user->fresh()->platform_role);
        $this->assertFalse(Storage::disk('local')->exists('local-platform-credentials.txt'));
    }
}
