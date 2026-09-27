<?php

namespace Tests\Feature;

use App\Filament\Resources\Centers\Pages\EditCenter;
use App\Filament\Resources\PlatformAuditLogs\Pages\ManagePlatformAuditLogs;
use App\Filament\Resources\Users\Pages\EditUser;
use App\Models\Center;
use App\Models\PlatformAuditLog;
use App\Models\User;
use App\Support\PlatformAudit;
use Filament\Actions\Testing\TestAction;
use Filament\Facades\Filament;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Livewire\Livewire;
use Tests\TestCase;

class PlatformAuditLogTest extends TestCase
{
    use RefreshDatabase;

    private function owner(): User
    {
        Filament::setCurrentPanel(Filament::getPanel('admin'));
        $owner = User::factory()->platformOwner()->create(['name' => 'مالك المنصة']);
        $this->actingAs($owner, 'platform');

        return $owner;
    }

    private function center(): Center
    {
        $center = Center::create([
            'name' => 'مركز ألفا', 'slug' => 'alpha', 'plan' => 'starter',
            'owner_email' => 'owner@alpha.test',
        ]);
        $center->domains()->create(['domain' => 'alpha.courses.test']);

        return $center;
    }

    private function audit(User $owner, ?Center $center, string $event, array $details, string $time = '2026-09-26 00:30:00'): PlatformAuditLog
    {
        $id = DB::connection('central')->table('platform_audit_logs')->insertGetId([
            'actor_id' => $owner->id, 'tenant_id' => $center?->id, 'event' => $event,
            'details' => json_encode($details, JSON_THROW_ON_ERROR), 'created_at' => $time,
        ]);

        return PlatformAuditLog::findOrFail($id);
    }

    public function test_audit_page_displays_names_arabic_events_and_safe_legacy_details(): void
    {
        $owner = $this->owner();
        $center = $this->center();
        $audit = $this->audit($owner, $center, 'center.updated', [
            'fields' => ['name', 'plan', 'suspended'], 'domain' => 'alpha.courses.test',
            'password' => 'never-display-this',
        ]);

        $page = Livewire::test(ManagePlatformAuditLogs::class)
            ->assertCanSeeTableRecords([$audit])
            ->assertSee('مالك المنصة')->assertSee('مركز ألفا')
            ->assertSee('تعديل بيانات المركز')->assertSee('الاسم، الخطة، حالة الإيقاف')
            ->assertDontSee('never-display-this');
        $page->mountAction(TestAction::make('details')->table($audit))
            ->assertActionMounted(TestAction::make('details')->table($audit));
        $content = $page->instance()->getMountedAction()->getModalContent()->render();
        $this->assertStringContainsString('القيم السابقة والجديدة غير مسجلة لهذا الحدث', $content);
        $this->assertStringContainsString('alpha.courses.test', $content);
        $this->assertStringNotContainsString('never-display-this', $content);
        $this->assertSame('ar', app()->getLocale());
    }

    public function test_search_filters_and_cairo_date_boundaries_stay_central_and_within_budget(): void
    {
        $owner = $this->owner();
        $center = $this->center();
        $audit = $this->audit($owner, $center, 'center.updated', ['fields' => ['plan']], '2026-09-25 22:30:00');
        $otherOwner = User::factory()->platformOwner()->create(['name' => 'شخص آخر']);
        $other = $this->audit($otherOwner, null, 'platform_user.created', [], '2026-09-26 22:30:00');
        for ($i = 0; $i < 12; $i++) {
            $this->audit($owner, $center, 'center.updated', ['fields' => ['plan']], '2026-09-25 20:00:00');
        }

        $queries = [];
        DB::listen(function (QueryExecuted $query) use (&$queries): void {
            $queries[] = $query->connectionName;
        });
        $page = Livewire::test(ManagePlatformAuditLogs::class);
        $this->assertLessThanOrEqual(6, count($queries));
        $this->assertSame(['central'], array_values(array_unique($queries)));

        $queries = [];
        $response = $this->get('http://courses.test/admin/platform-audit-logs')->assertOk();
        $this->assertNotNull($response->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $response->headers->get('X-Courses-Query-Count'));
        $this->assertSame(['central'], array_values(array_unique($queries)));

        foreach (['مركز ألفا', 'مالك المنصة', 'تعديل بيانات المركز'] as $search) {
            $queries = [];
            $page->searchTable($search)->assertCanSeeTableRecords([$audit])->assertCanNotSeeTableRecords([$other]);
            $this->assertLessThanOrEqual(6, count($queries));
        }
        $page->searchTable('')->filterTable('event', 'platform_user.created')
            ->assertCanSeeTableRecords([$other])->assertCanNotSeeTableRecords([$audit]);
        $page->resetTableFilters()->filterTable('tenant_id', $center->id)->assertCanNotSeeTableRecords([$other]);
        $page->resetTableFilters()->filterTable('actor_id', $otherOwner->id)->assertCanSeeTableRecords([$other]);
        $page->resetTableFilters()->filterTable('tenant_id', $center->id);
        $queries = [];
        $page->filterTable('actor_id', $owner->id)->assertCanSeeTableRecords([$audit]);
        $this->assertLessThanOrEqual(6, count($queries));
        $page->resetTableFilters()->filterTable('period', ['from' => '2026-09-26', 'until' => '2026-09-26'])
            ->assertCanSeeTableRecords([$audit])->assertCanNotSeeTableRecords([$other]);
        $page->filterTable('period', ['from' => 'not-a-date', 'until' => null])->assertSuccessful();
    }

    public function test_center_api_and_form_record_only_actual_changes_with_before_and_after_values(): void
    {
        $this->owner();
        $center = $this->center();
        $this->patchJson("http://courses.test/api/v1/platform/centers/{$center->id}", [
            'name' => $center->name, 'plan' => 'growth', 'suspended' => true,
        ])->assertOk();
        $audit = PlatformAuditLog::latest('id')->firstOrFail();
        $this->assertSame([
            'plan' => ['before' => 'starter', 'after' => 'growth'],
            'suspended' => ['before' => false, 'after' => true],
        ], $audit->details['changes']);

        $page = Livewire::test(ManagePlatformAuditLogs::class)
            ->mountAction(TestAction::make('details')->table($audit));
        $content = $page->instance()->getMountedAction()->getModalContent()->render();
        foreach (['قبل التغيير', 'بعد التغيير', 'بداية', 'نمو', 'نشط', 'موقوف'] as $text) {
            $this->assertStringContainsString($text, $content);
        }

        Livewire::test(EditCenter::class, ['record' => $center->id])->fillForm([
            'name' => 'مركز جديد', 'plan' => 'growth', 'suspended' => true, 'subdomain' => 'alpha-new',
        ])->call('save')->assertHasNoFormErrors();
        $audit = PlatformAuditLog::latest('id')->firstOrFail();
        $this->assertSame([
            'name' => ['before' => 'مركز ألفا', 'after' => 'مركز جديد'],
            'domain' => ['before' => 'alpha.courses.test', 'after' => 'alpha-new.courses.test'],
        ], $audit->details['changes']);

        $this->putJson("http://courses.test/api/v1/platform/centers/{$center->id}/domain", ['subdomain' => 'alpha-last'])->assertOk();
        $audit = PlatformAuditLog::latest('id')->firstOrFail();
        $this->assertSame(['before' => 'alpha-new.courses.test', 'after' => 'alpha-last.courses.test'], $audit->details['changes']['domain']);
        $count = PlatformAuditLog::count();
        $this->patchJson("http://courses.test/api/v1/platform/centers/{$center->id}", ['plan' => 'growth'])->assertOk();
        $this->assertSame($count, PlatformAuditLog::count());
        $this->putJson("http://courses.test/api/v1/platform/centers/{$center->id}/domain", ['subdomain' => 'alpha-last'])->assertOk();
        $this->assertSame($count, PlatformAuditLog::count());
    }

    public function test_user_changes_preserve_role_history_without_password_or_authentication_values(): void
    {
        $this->owner();
        $user = User::factory()->create(['name' => 'موظف سابق', 'platform_role' => 'platform_support']);
        Livewire::test(EditUser::class, ['record' => $user->id])->fillForm([
            'name' => 'موظف جديد', 'email' => $user->email,
            'platform_role' => 'platform_owner', 'password' => 'secret-password-never-log',
        ])->call('save')->assertHasNoFormErrors();
        $audit = PlatformAuditLog::where('event', 'platform_user.updated')->firstOrFail();
        $this->assertSame(['name' => ['before' => 'موظف سابق', 'after' => 'موظف جديد']], $audit->details['changes']);
        $this->assertContains('password', $audit->details['changed_fields']);
        $role = PlatformAuditLog::where('event', 'platform_user.role_changed')->firstOrFail();
        $this->assertSame(['before' => 'platform_support', 'after' => 'platform_owner'], $role->details['changes']['platform_role']);
        $all = DB::connection('central')->table('platform_audit_logs')->pluck('details')->join(' ');
        $this->assertStringNotContainsString('secret-password-never-log', $all);
        $this->assertStringNotContainsString($user->fresh()->password, $all);
    }

    public function test_legacy_user_events_show_the_affected_user_id_in_the_details_modal(): void
    {
        $owner = $this->owner();
        $user = User::factory()->create(['platform_role' => 'platform_support']);

        foreach ([
            'platform_user.created' => ['role' => 'platform_support'],
            'platform_user.updated' => ['changed_fields' => ['name']],
            'platform_user.role_changed' => ['old_role' => 'platform_support', 'new_role' => 'platform_owner'],
        ] as $event => $details) {
            $audit = $this->audit($owner, null, $event, ['user_id' => $user->id, ...$details]);
            $page = Livewire::test(ManagePlatformAuditLogs::class)
                ->mountAction(TestAction::make('details')->table($audit));
            $content = $page->instance()->getMountedAction()->getModalContent()->render();

            $this->assertStringContainsString('معرّف الموظف', $content);
            $this->assertStringContainsString('<bdi>'.$user->id.'</bdi>', $content);
        }

        $audit = $this->audit($owner, null, 'platform_user.created', [
            'user_id' => $user->id, 'user_name' => 'اسم الموظف المسجل',
        ]);
        $page = Livewire::test(ManagePlatformAuditLogs::class)
            ->mountAction(TestAction::make('details')->table($audit));
        $content = $page->instance()->getMountedAction()->getModalContent()->render();

        $this->assertStringContainsString('اسم الموظف المسجل', $content);
        $this->assertStringNotContainsString('معرّف الموظف', $content);
    }

    public function test_missing_identities_unknown_events_and_untrusted_details_have_safe_fallbacks(): void
    {
        $owner = $this->owner();
        $audit = $this->audit($owner, null, 'unknown.event', [
            'changes' => ['password' => ['before' => 'secret-before', 'after' => 'secret-after']],
            'actor_name' => 'اسم محفوظ', 'center_name' => 'مركز محفوظ',
            'user_name' => '<script>unsafe()</script>',
        ]);
        DB::connection('central')->table('platform_audit_logs')->where('id', $audit->id)
            ->update(['actor_id' => null, 'tenant_id' => 'removed-center']);
        $page = Livewire::test(ManagePlatformAuditLogs::class)
            ->assertSee('اسم محفوظ')->assertSee('مركز محفوظ')->assertSee('حدث غير مصنف');
        $page->mountAction(TestAction::make('details')->table($audit));
        $content = $page->instance()->getMountedAction()->getModalContent()->render();
        $this->assertStringNotContainsString('secret-before', $content);
        $this->assertStringNotContainsString('secret-after', $content);
        $this->assertStringNotContainsString('<script>', $content);
        $this->assertStringContainsString('&lt;script&gt;', $content);

        PlatformAudit::record($owner, null, 'platform_user.updated', [
            'password' => 'do-not-store', 'token' => 'do-not-store', 'app_authentication_secret' => 'do-not-store',
            'changes' => ['password' => ['before' => 'do-not-store', 'after' => 'do-not-store']],
            'changed_fields' => ['password', 'app_authentication_secret'],
        ]);
        $stored = PlatformAuditLog::latest('id')->firstOrFail();
        $this->assertSame([], $stored->details['changes']);
        $this->assertSame(['password'], $stored->details['changed_fields']);
        $this->assertStringNotContainsString('do-not-store', json_encode($stored->details, JSON_THROW_ON_ERROR));
    }

    public function test_platform_owner_access_is_rechecked_after_a_role_change_on_an_open_page(): void
    {
        $owner = $this->owner();
        $page = Livewire::test(ManagePlatformAuditLogs::class)->assertSuccessful();
        $owner->forceFill(['platform_role' => 'platform_support'])->save();
        $this->actingAs($owner, 'platform');
        $page->call('$refresh')->assertStatus(403);
        Livewire::test(ManagePlatformAuditLogs::class)->assertStatus(403);
    }
}
