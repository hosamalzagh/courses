<?php

namespace Tests\Feature;

use App\Filament\Resources\Centers\Pages\ListCenters;
use App\Filament\Resources\Users\Pages\CreateUser;
use App\Filament\Resources\Users\Pages\EditUser;
use App\Filament\Resources\Users\Pages\ListUsers;
use App\Models\Center;
use App\Models\User;
use Filament\Auth\MultiFactor\App\AppAuthentication;
use Filament\Auth\Pages\Login;
use Filament\Facades\Filament;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Cache;
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
        $this->actingAs($centerEmployee, 'web')->get('http://courses.test/admin')
            ->assertRedirect('http://courses.test/admin/login');

        $owner = User::factory()->create(['platform_role' => 'platform_owner']);
        $this->actingAs($owner, 'platform')->get('http://courses.test/admin')
            ->assertRedirect('http://courses.test/admin/multi-factor-authentication/set-up');
        $this->getJson('http://courses.test/api/v1/platform/centers')->assertForbidden();
        $owner->saveAppAuthenticationSecret(AppAuthentication::make()->generateSecret());
        $this->getJson('http://courses.test/api/v1/platform/centers')->assertOk();

        $support = User::factory()->create(['platform_role' => 'platform_support']);
        $this->actingAs($support, 'platform')->getJson('http://courses.test/api/v1/platform/centers')->assertForbidden();
    }

    public function test_owner_login_requires_a_valid_second_factor_and_landlord_pages_stay_within_query_budget(): void
    {
        $authenticator = AppAuthentication::make();
        $owner = User::factory()->create([
            'platform_role' => 'platform_owner',
            'app_authentication_secret' => $authenticator->generateSecret(),
        ]);
        Filament::setCurrentPanel(Filament::getPanel('admin'));
        Cache::flush();
        $this->withServerVariables(['REMOTE_ADDR' => '10.13.'.random_int(1, 254).'.'.random_int(1, 254)]);

        $login = Livewire::test(Login::class)
            ->fillForm(['email' => $owner->email, 'password' => 'password'])
            ->call('authenticate');

        $this->assertGuest('platform');
        $login->set('data.multiFactor.app.code', $authenticator->getCurrentCode($owner))
            ->call('authenticate')
            ->assertHasNoErrors();
        $this->assertAuthenticatedAs($owner, 'platform');

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

        $center->update([
            'provisioning_status' => 'failed',
            'database_state' => 'available',
            'migration_version' => '2026_09_25_180000_create_center_tables',
            'provisioning_error' => 'تعذر ترحيل قاعدة بيانات المركز. راجع سجل التشغيل وأعد المحاولة.',
        ]);
        Auth::forgetGuards();
        $statusPage = $this->get("http://courses.test/admin/centers/{$center->id}")
            ->assertOk()
            ->assertSee('تعذر ترحيل قاعدة بيانات المركز')
            ->assertSee('failed')
            ->assertSee('available')
            ->assertSee('2026_09_25_180000_create_center_tables');
        $this->assertLessThanOrEqual(6, (int) $statusPage->headers->get('X-Courses-Query-Count'));
        Auth::forgetGuards();
        $warmStatusPage = $this->get("http://courses.test/admin/centers/{$center->id}")->assertOk();
        $this->assertLessThanOrEqual(6, (int) $warmStatusPage->headers->get('X-Courses-Query-Count'));

    }

    public function test_landlord_center_search_stays_within_query_budget_without_tenant_reads(): void
    {
        Filament::setCurrentPanel(Filament::getPanel('admin'));
        $this->actingAs(User::factory()->create(['platform_role' => 'platform_owner']), 'platform');
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

    public function test_support_has_mfa_and_central_status_only_even_with_direct_urls(): void
    {
        $support = User::factory()->create(['platform_role' => 'platform_support']);
        $center = Center::create([
            'name' => 'Alpha Center', 'slug' => 'alpha', 'plan' => 'starter',
            'owner_email' => 'owner@alpha.test',
        ]);
        $center->domains()->create(['domain' => 'alpha.courses.test']);

        $this->actingAs($support, 'platform')->get('http://courses.test/admin')
            ->assertRedirect('http://courses.test/admin/multi-factor-authentication/set-up');

        $authenticator = AppAuthentication::make();
        $support->saveAppAuthenticationSecret($authenticator->generateSecret());
        Filament::setCurrentPanel(Filament::getPanel('admin'));
        Cache::flush();
        $this->post('http://courses.test/admin/logout');
        $this->withServerVariables(['REMOTE_ADDR' => '10.14.'.random_int(1, 254).'.'.random_int(1, 254)]);
        $login = Livewire::test(Login::class)
            ->fillForm(['email' => $support->email, 'password' => 'password'])
            ->call('authenticate');
        $this->assertGuest('platform');
        $login->set('data.multiFactor.app.code', $authenticator->getCurrentCode($support))
            ->call('authenticate')->assertHasNoErrors();
        $this->assertAuthenticatedAs($support, 'platform');

        foreach ([
            'http://courses.test/admin/users',
            "http://courses.test/admin/users/{$support->id}/edit",
            'http://courses.test/admin/platform-audit-logs',
            'http://courses.test/admin/centers/create',
            "http://courses.test/admin/centers/{$center->id}/edit",
        ] as $url) {
            Auth::forgetGuards();
            $this->get($url)->assertForbidden();
        }
        foreach (['http://courses.test/admin/centers', "http://courses.test/admin/centers/{$center->id}"] as $url) {
            Auth::forgetGuards();
            $response = $this->get($url)->assertOk();
            $this->assertNotNull($response->headers->get('X-Courses-Query-Count'));
            $this->assertLessThanOrEqual(6, (int) $response->headers->get('X-Courses-Query-Count'));
        }
        $this->patchJson("http://courses.test/api/v1/platform/centers/{$center->id}", ['name' => 'Denied'])->assertForbidden();
        $this->putJson("http://courses.test/api/v1/platform/centers/{$center->id}/domain", ['subdomain' => 'denied'])->assertForbidden();
        $this->postJson("http://courses.test/api/v1/platform/centers/{$center->id}/retry")->assertForbidden();
    }

    public function test_platform_user_management_is_scoped_and_audits_all_changes_without_secrets(): void
    {
        Filament::setCurrentPanel(Filament::getPanel('admin'));
        $owner = User::factory()->create([
            'platform_role' => 'platform_owner',
            'app_authentication_secret' => AppAuthentication::make()->generateSecret(),
        ]);
        $support = User::factory()->create(['platform_role' => 'platform_support']);
        $centerEmployee = User::factory()->create();
        $this->actingAs($owner, 'platform');

        Livewire::test(CreateUser::class)->fillForm([
            'name' => 'New Support', 'email' => 'support-new@courses.test',
            'platform_role' => 'platform_support', 'password' => 'temporary-password-long',
        ])->call('create')->assertHasNoFormErrors();
        $created = User::where('email', 'support-new@courses.test')->firstOrFail();
        $this->assertSame('platform_support', $created->platform_role);
        $this->assertDatabaseHas('platform_audit_logs', [
            'actor_id' => $owner->id, 'event' => 'platform_user.created',
        ], 'central');

        Livewire::test(ListUsers::class)->assertCanSeeTableRecords([$owner, $support, $created])
            ->assertCanNotSeeTableRecords([$centerEmployee]);
        $this->get("http://courses.test/admin/users/{$centerEmployee->id}/edit")->assertNotFound();

        Livewire::test(EditUser::class, ['record' => $support->id])
            ->fillForm([
                'name' => 'Updated Support', 'email' => $support->email,
                'platform_role' => 'platform_support', 'password' => 'new-password-long-enough',
            ])->call('save')->assertHasNoFormErrors();
        $this->assertSame('Updated Support', $support->fresh()->name);
        $this->assertTrue(password_verify('new-password-long-enough', $support->fresh()->password));
        $audit = DB::connection('central')->table('platform_audit_logs')
            ->where('event', 'platform_user.updated')->latest('id')->first();
        $this->assertNotNull($audit);
        $this->assertSame($owner->id, $audit->actor_id);
        $this->assertStringNotContainsString('new-password-long-enough', $audit->details);
        $this->assertSame(['name', 'password'], json_decode($audit->details, true)['changed_fields']);

        Livewire::test(EditUser::class, ['record' => $created->id])
            ->fillForm([
                'name' => $created->name, 'email' => $created->email,
                'platform_role' => 'platform_owner', 'password' => '',
            ])->call('save')->assertHasNoFormErrors();
        $this->assertSame('platform_owner', $created->fresh()->platform_role);
        $this->assertDatabaseHas('platform_audit_logs', [
            'actor_id' => $owner->id, 'event' => 'platform_user.role_changed',
        ], 'central');
    }

    public function test_existing_center_session_cannot_become_a_platform_session_after_role_promotion(): void
    {
        $user = User::factory()->create([
            'app_authentication_secret' => AppAuthentication::make()->generateSecret(),
        ]);
        $this->actingAs($user, 'web');
        $user->forceFill(['platform_role' => 'platform_support'])->save();

        $this->getJson('http://courses.test/api/v1/platform/centers')->assertUnauthorized();
        $this->get('http://courses.test/admin/centers')->assertRedirect('http://courses.test/admin/login');
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
