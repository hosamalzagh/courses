<?php

namespace Tests\Feature;

use App\Jobs\ProvisionCenter;
use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use App\Support\CenterAuditDelivery;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Schema;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class CenterRestoreTest extends TestCase
{
    use CleansCenterDatabases;

    public function test_restoring_alpha_keeps_beta_and_central_identity_and_removes_orphan_grants(): void
    {
        abort_unless(config('database.connections.central.database') === 'courses_test_central', 500);
        Artisan::call('migrate:fresh', ['--database' => 'central', '--force' => true]);
        Mail::fake();
        $platformOwner = User::factory()->platformOwner()->create();
        foreach (['alpha', 'beta'] as $slug) {
            $center = Center::create([
                'name' => ucfirst($slug), 'slug' => $slug, 'plan' => 'starter',
                'owner_email' => "owner@{$slug}.test",
            ]);
            $center->domains()->create(['domain' => "{$slug}.courses.test"]);
            ProvisionCenter::dispatchSync($center->id);
            $center->run(fn () => DB::table('branches')->insert([
                'name' => $slug, 'slug' => $slug, 'created_at' => now(), 'updated_at' => now(),
            ]));
        }
        $alpha = Center::where('slug', 'alpha')->firstOrFail();
        $beta = Center::where('slug', 'beta')->firstOrFail();
        $password = 'restore-owner-password-123';
        $owner = User::factory()->create(['email_verified_at' => now(), 'password' => $password]);
        $suspendedMember = User::factory()->create(['email_verified_at' => now(), 'password' => $password]);
        $unlinkedUser = User::factory()->create(['email_verified_at' => now(), 'password' => $password]);
        CenterMembership::create(['tenant_id' => $alpha->id, 'user_id' => $owner->id, 'status' => 'active']);
        CenterMembership::create(['tenant_id' => $alpha->id, 'user_id' => $suspendedMember->id, 'status' => 'suspended']);
        $alpha->run(function () use ($owner, $suspendedMember, $unlinkedUser): void {
            foreach ([$owner->id, $unlinkedUser->id, 999999] as $userId) {
                DB::table('center_grants')->insert([
                    'user_id' => $userId, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
                ]);
            }
            $branchId = DB::table('branches')->value('id');
            foreach ([$suspendedMember->id, $unlinkedUser->id, 999999] as $userId) {
                DB::table('branch_grants')->insert([
                    'user_id' => $userId, 'branch_id' => $branchId, 'role' => 'branch_manager',
                    'created_at' => now(), 'updated_at' => now(),
                ]);
            }
        });
        $betaOwner = User::factory()->create(['email_verified_at' => now(), 'password' => $password]);
        CenterMembership::create(['tenant_id' => $beta->id, 'user_id' => $betaOwner->id, 'status' => 'active']);
        $beta->run(fn () => DB::table('center_grants')->insert([
            'user_id' => $betaOwner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
        ]));
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', [
            'email' => $suspendedMember->email, 'password' => $password,
        ])->assertForbidden()->assertJsonPath('code', 'membership_suspended');
        $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', [
            'email' => $unlinkedUser->email, 'password' => $password,
        ])->assertForbidden();

        // Simulate a snapshot taken before the audit delivery migration.
        $alpha->run(function (): void {
            Schema::table('center_audit_logs', fn ($table) => $table->dropColumn('source_event_id'));
            DB::table('migrations')->where('migration', '2026_09_25_220000_add_audit_source_event_id')->delete();
        });

        $this->assertSame(0, Artisan::call('courses:backup', ['slug' => 'alpha']));
        $files = glob(storage_path("app/private/backups/alpha-{$alpha->id}-*.dump"));
        $file = end($files);
        $this->assertFileExists($file);
        try {
            $this->assertSame(0600, fileperms($file) & 0777);
            $this->assertSame(0, Artisan::call('tenants:migrate', [
                '--tenants' => [$alpha->id], '--force' => true,
            ]));
            $auditId = CenterAuditDelivery::record($alpha->id, $owner->id, 'test.after_backup', []);
            CenterAuditDelivery::deliver($auditId);
            $this->assertSame(1, $alpha->run(fn () => DB::table('center_audit_logs')
                ->where('source_event_id', $auditId)->count()));
            $laterOwner = User::factory()->create(['email_verified_at' => now(), 'password' => $password]);
            CenterMembership::create(['tenant_id' => $alpha->id, 'user_id' => $laterOwner->id, 'status' => 'active']);
            $alpha->run(function () use ($owner, $laterOwner): void {
                DB::table('center_grants')->where('user_id', $owner->id)->delete();
                DB::table('center_grants')->insert([
                    'user_id' => $laterOwner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
                ]);
            });
            $alpha->run(fn () => DB::table('branches')->insert([
                'name' => 'temporary', 'slug' => 'temporary', 'created_at' => now(), 'updated_at' => now(),
            ]));
            $alpha->update(['migration_version' => 'stale-before-restore']);
            $identitiesBefore = DB::connection('central')->table('users')->orderBy('id')->get()->toArray();
            $betaMetadataBefore = $beta->fresh()->getAttributes();
            $betaMembershipBefore = CenterMembership::where('tenant_id', $beta->id)->get()->toArray();
            $this->assertSame(1, Artisan::call('courses:restore', [
                'slug' => 'beta', 'file' => $file, '--confirm' => 'beta',
            ]));

            $this->assertSame(0, Artisan::call('courses:restore', [
                'slug' => 'alpha', 'file' => $file, '--confirm' => 'alpha',
            ]));
            $this->assertSame(['alpha'], $alpha->run(fn () => DB::table('branches')->pluck('slug')->all()));
            $this->assertTrue($alpha->run(fn () => Schema::hasColumn('center_audit_logs', 'source_event_id')));
            $this->assertSame(1, $alpha->run(fn () => DB::table('center_audit_logs')
                ->where('source_event_id', $auditId)->count()));
            $this->assertSame(['beta'], $beta->run(fn () => DB::table('branches')->pluck('slug')->all()));
            $this->assertSame(0, $alpha->run(fn () => DB::table('center_grants')->whereIn('user_id', [$unlinkedUser->id, 999999])->count()));
            $this->assertSame(0, $alpha->run(fn () => DB::table('branch_grants')
                ->whereIn('user_id', [$suspendedMember->id, $unlinkedUser->id, 999999])->count()));
            $latestMigration = $alpha->run(fn () => DB::table('migrations')->max('migration'));
            $this->assertSame($latestMigration, $alpha->fresh()->migration_version);
            $this->assertEquals($identitiesBefore, DB::connection('central')->table('users')->orderBy('id')->get()->toArray());
            $this->assertSame($betaMetadataBefore, $beta->fresh()->getAttributes());
            $this->assertSame($betaMembershipBefore, CenterMembership::where('tenant_id', $beta->id)->get()->toArray());
            $this->actingAs($platformOwner, 'platform')->getJson("http://courses.test/api/v1/platform/centers/{$alpha->id}")
                ->assertOk()->assertJsonPath('center.migration_version', $latestMigration);
            $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', [
                'email' => $owner->email, 'password' => $password,
            ])->assertOk();
            $this->getJson('http://alpha.courses.test/api/v1/center/user')
                ->assertOk()->assertJsonPath('permissions.center_roles.0', 'center_owner');
            $this->postJson('http://alpha.courses.test/api/v1/center/auth/login', [
                'email' => $laterOwner->email, 'password' => $password,
            ])->assertOk();
            $this->getJson('http://alpha.courses.test/api/v1/center/user')
                ->assertOk()->assertJsonPath('permissions.center_roles.0', 'center_owner');
            $this->getJson('http://beta.courses.test/api/v1/center/user')->assertUnauthorized();
            $this->postJson('http://beta.courses.test/api/v1/center/auth/login', [
                'email' => $betaOwner->email, 'password' => $password,
            ])->assertOk();
            $this->getJson('http://beta.courses.test/api/v1/center/user')
                ->assertOk()->assertJsonPath('branches.0.slug', 'beta');
        } finally {
            if (is_file($file)) {
                unlink($file);
            }
        }
    }
}
