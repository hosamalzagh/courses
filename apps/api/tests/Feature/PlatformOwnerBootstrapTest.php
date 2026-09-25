<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class PlatformOwnerBootstrapTest extends TestCase
{
    use RefreshDatabase;

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
