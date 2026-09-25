<?php

namespace Tests\Feature;

use App\Filament\Resources\Centers\Pages\ListCenters;
use App\Models\Center;
use App\Models\User;
use Filament\Auth\MultiFactor\App\AppAuthentication;
use Filament\Auth\Pages\Login;
use Filament\Facades\Filament;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
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

    public function test_owner_login_requires_a_valid_second_factor_and_landlord_pages_stay_within_query_budget(): void
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

        $center = Center::create([
            'name' => 'Alpha Center', 'slug' => 'alpha', 'plan' => 'starter',
            'owner_email' => 'owner@alpha.test',
        ]);
        $center->domains()->create(['domain' => 'alpha.courses.test']);

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

    public function test_landlord_center_search_stays_within_query_budget_without_tenant_reads(): void
    {
        Filament::setCurrentPanel(Filament::getPanel('admin'));
        $this->actingAs(User::factory()->create(['platform_role' => 'platform_owner']));
        $center = Center::create([
            'name' => 'Alpha Center', 'slug' => 'alpha', 'plan' => 'starter',
            'owner_email' => 'owner@alpha.test',
        ]);
        $center->domains()->create(['domain' => 'alpha.courses.test']);

        $list = Livewire::test(ListCenters::class);
        $count = 0;
        $connections = [];
        $measuring = false;
        DB::listen(function (QueryExecuted $query) use (&$count, &$connections, &$measuring): void {
            if ($measuring) {
                $count++;
                $connections[] = $query->connectionName;
            }
        });

        $measuring = true;
        $list->searchTable('Alpha')
            ->assertCanSeeTableRecords([$center]);
        $measuring = false;
        $this->assertLessThanOrEqual(6, $count);
        $this->assertSame(['central'], array_values(array_unique($connections)));

        $count = 0;
        $connections = [];
        $measuring = true;
        $list->searchTable('Missing')->assertCanNotSeeTableRecords([$center]);
        $measuring = false;
        $this->assertLessThanOrEqual(6, $count);
        $this->assertSame(['central'], array_values(array_unique($connections)));
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
