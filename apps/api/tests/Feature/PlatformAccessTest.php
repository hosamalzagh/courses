<?php

namespace Tests\Feature;

use App\Models\User;
use Filament\Auth\MultiFactor\App\AppAuthentication;
use Filament\Auth\Pages\Login;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Auth;
use Livewire\Livewire;
use Symfony\Component\Process\Process;
use Tests\TestCase;

class PlatformAccessTest extends TestCase
{
    use RefreshDatabase;

    public function test_landlord_requires_platform_role_and_mfa_setup(): void
    {
        $this->get('http://courses.test/admin')->assertRedirect('http://courses.test/admin/login');

        $centerEmployee = User::factory()->create();
        $this->actingAs($centerEmployee)->get('http://courses.test/admin')->assertForbidden();

        $owner = User::factory()->create(['platform_role' => 'platform_owner']);
        $this->actingAs($owner)->get('http://courses.test/admin')
            ->assertRedirect('http://courses.test/admin/multi-factor-authentication/set-up');
    }

    public function test_owner_login_requires_a_valid_second_factor(): void
    {
        $authenticator = AppAuthentication::make();
        $owner = User::factory()->create([
            'platform_role' => 'platform_owner',
            'app_authentication_secret' => $authenticator->generateSecret(),
        ]);
        Filament::setCurrentPanel(Filament::getPanel('admin'));

        $login = Livewire::test(Login::class)
            ->fillForm(['email' => $owner->email, 'password' => 'password'])
            ->call('authenticate');

        $this->assertGuest();
        $login->set('data.multiFactor.app.code', $authenticator->getCurrentCode($owner))
            ->call('authenticate')
            ->assertHasNoErrors();
        $this->assertAuthenticatedAs($owner);

        Auth::forgetGuards();
        $response = $this->get('http://courses.test/admin');
        $response->assertOk();
        $this->assertNotNull($response->headers->get('X-Courses-Query-Count'));
        $this->assertGreaterThan(0, (int) $response->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $response->headers->get('X-Courses-Query-Count'));
        foreach (['centers', 'users', 'platform-audit-logs'] as $page) {
            Auth::forgetGuards();
            $pageResponse = $this->get("http://courses.test/admin/{$page}")->assertOk();
            $this->assertLessThanOrEqual(6, (int) $pageResponse->headers->get('X-Courses-Query-Count'), $page);
        }
    }

    public function test_telescope_routes_are_absent_in_production_even_if_enabled_by_environment(): void
    {
        $process = new Process(
            [PHP_BINARY, 'artisan', 'route:list', '--path=telescope', '--json', '--no-interaction'],
            base_path(),
            ['APP_ENV' => 'production', 'TELESCOPE_ENABLED' => 'true'],
        );
        $process->mustRun();

        $this->assertSame([], json_decode($process->getOutput(), true, flags: JSON_THROW_ON_ERROR));
    }
}
