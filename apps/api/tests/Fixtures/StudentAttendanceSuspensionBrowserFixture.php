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

if (! app()->isLocal() || getenv('COURSES_BROWSER_ISOLATED') !== '1'
    || config('database.connections.central.database') !== 'courses_test_central_issue70') {
    throw new RuntimeException('Use the isolated issue70 browser database.');
}

$password = Str::random(32);
$owner = User::firstOrCreate(['email' => 'owner@issue70.test'], [
    'name' => 'مالك قبول الحضور', 'password' => $password, 'email_verified_at' => now(),
]);
$owner->forceFill(['password' => $password, 'email_verified_at' => now()])->save();
$center = Center::firstOrCreate(['slug' => 'alpha'], [
    'name' => 'مركز قبول الحضور', 'plan' => 'starter', 'owner_email' => $owner->email,
]);
$center->domains()->firstOrCreate(['domain' => 'alpha.courses.test']);
if ($center->provisioning_status !== 'active') {
    ProvisionCenter::dispatchSync($center->id);
    $center->refresh();
}
if ($center->provisioning_status !== 'active') {
    throw new RuntimeException('Fixture provisioning failed.');
}
CenterMembership::firstOrCreate(['tenant_id' => $center->id, 'user_id' => $owner->id], ['status' => 'active']);
$center->run(function () use ($owner): void {
    DB::table('center_grants')->insertOrIgnore(['user_id' => $owner->id, 'role' => 'center_owner']);
    DB::table('branches')->insertOrIgnore([
        'name' => 'الفرع الشمالي', 'slug' => 'north', 'created_at' => now(), 'updated_at' => now(),
    ]);
});

$path = storage_path('app/private/issue70-browser-credentials.json');
file_put_contents($path, json_encode(['email' => $owner->email, 'password' => $password]));
chmod($path, 0600);
