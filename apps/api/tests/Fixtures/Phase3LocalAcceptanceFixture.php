<?php

use App\Jobs\ProvisionCenter;
use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Support\Facades\DB;

if (! app()->isLocal()
    || getenv('COURSES_PHASE3_ISOLATED') !== '1'
    || config('database.connections.central.host') !== '127.0.0.1'
    || (string) config('database.connections.central.port') !== '5554'
    || config('database.connections.central.database') !== 'courses_issue54_central') {
    throw new RuntimeException('Phase 3 acceptance requires its disposable PostgreSQL cluster on port 5554.');
}

$credentials = [];

foreach (['alpha', 'beta'] as $slug) {
    $center = Center::create([
        'name' => $slug === 'alpha' ? 'مركز ألفا' : 'مركز بيتا',
        'slug' => $slug,
        'plan' => 'starter',
        'owner_email' => "owner@{$slug}.test",
    ]);
    $center->domains()->create(['domain' => "{$slug}.courses.test"]);
    ProvisionCenter::dispatchSync($center->id);
    $center->refresh();

    if ($center->provisioning_status !== 'active') {
        throw new RuntimeException("Provisioning {$slug} failed.");
    }

    $password = bin2hex(random_bytes(24));
    $owner = User::factory()->create([
        'name' => "مالك {$slug}",
        'email' => "owner@{$slug}.test",
        'password' => $password,
    ]);
    CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $owner->id, 'status' => 'active']);
    $center->run(function () use ($owner) {
        DB::table('center_grants')->insert(['user_id' => $owner->id, 'role' => 'center_owner']);

        foreach (['north' => 'الفرع الشمالي', 'south' => 'الفرع الجنوبي'] as $branch => $name) {
            DB::table('branches')->insert([
                'name' => $name,
                'slug' => $branch,
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }
    });
    $credentials[$slug] = ['email' => $owner->email, 'password' => $password];

    if ($slug === 'alpha') {
        $staffPassword = bin2hex(random_bytes(24));
        $staff = User::factory()->create([
            'name' => 'موظف التسجيل الشمالي',
            'email' => 'staff@alpha.test',
            'password' => $staffPassword,
        ]);
        $membership = CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $staff->id, 'status' => 'active']);
        $center->run(fn () => DB::table('branch_grants')->insert([
            'user_id' => $staff->id,
            'branch_id' => DB::table('branches')->where('slug', 'north')->value('id'),
            'role' => 'registration',
        ]));
        $credentials['staff'] = ['email' => $staff->email, 'password' => $staffPassword, 'membership_id' => $membership->id];
    }
}

$file = storage_path('app/private/phase3-local-acceptance-credentials.json');
file_put_contents($file, json_encode($credentials, JSON_THROW_ON_ERROR));
chmod($file, 0600);
