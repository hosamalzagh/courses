<?php

use App\Jobs\ProvisionCenter;
use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

require __DIR__.'/../../vendor/autoload.php';
$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
if (! app()->isLocal() || getenv('COURSES_BROWSER_ISOLATED') !== '1' || config('database.connections.central.database') !== 'courses_issue35_browser' || (string) config('database.connections.central.port') === '5432') {
    fwrite(STDERR, "Use the isolated issue35 browser database and a non-default PostgreSQL port.\n");
    exit(1);
}

$credentials = [];
foreach (['alpha', 'staff'] as $role) {
    $password = Str::random(32);
    $user = User::firstOrCreate(['email' => "{$role}@issue35.test"], [
        'name' => $role === 'alpha' ? 'مالك الدراسة' : 'موظف التسجيل',
        'password' => $password, 'email_verified_at' => now(),
    ]);
    $user->forceFill(['password' => $password, 'email_verified_at' => now()])->save();
    $credentials[$role] = ['id' => $user->id, 'email' => $user->email, 'password' => $password];
}

$center = Center::firstOrCreate(['slug' => 'alpha'], [
    'name' => 'مركز قبول الحساب', 'plan' => 'starter', 'owner_email' => 'owner@issue35.test',
]);
$center->domains()->firstOrCreate(['domain' => 'alpha.courses.test']);
if ($center->provisioning_status !== 'active') {
    ProvisionCenter::dispatchSync($center->id);
    $center->refresh();
}
if ($center->provisioning_status !== 'active') {
    throw new RuntimeException('Fixture provisioning failed.');
}
foreach ($credentials as $role => $user) {
    $membership = CenterMembership::firstOrCreate(['tenant_id' => $center->id, 'user_id' => $user['id']], ['status' => 'active']);
    $credentials[$role]['membership_id'] = $membership->id;
}
$center->run(function () use ($credentials): void {
    DB::table('center_grants')->insertOrIgnore(['user_id' => $credentials['alpha']['id'], 'role' => 'center_owner']);
    foreach (['north' => 'الفرع الشمالي', 'south' => 'الفرع الجنوبي'] as $slug => $name) {
        DB::table('branches')->insertOrIgnore(['slug' => $slug, 'name' => $name, 'created_at' => now(), 'updated_at' => now()]);
    }
});

$file = storage_path('app/private/issue35-browser-credentials.json');
file_put_contents($file, json_encode($credentials));
chmod($file, 0600);
