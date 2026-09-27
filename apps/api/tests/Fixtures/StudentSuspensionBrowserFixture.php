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
if (! app()->isLocal() || getenv('COURSES_BROWSER_ISOLATED') !== '1' || config('database.connections.central.database') !== 'courses_issue68_browser' || (string) config('database.connections.central.port') === '5432') {
    throw new RuntimeException('Use an isolated issue68 browser database and port.');
}
$credentials = [];
foreach (['owner', 'staff'] as $role) {
    $password = Str::random(32);
    $user = User::firstOrCreate(['email' => "{$role}@issue68.test"], ['name' => $role === 'owner' ? 'مالك القبول' : 'موظف القبول', 'password' => $password, 'email_verified_at' => now()]);
    $user->forceFill(['password' => $password, 'email_verified_at' => now()])->save();
    $credentials[$role] = ['id' => $user->id, 'email' => $user->email, 'password' => $password];
}
foreach (['alpha', 'beta'] as $slug) {
    $center = Center::firstOrCreate(['slug' => $slug], ['name' => $slug, 'plan' => 'starter', 'owner_email' => "owner@{$slug}.test"]);
    $center->domains()->firstOrCreate(['domain' => "{$slug}.courses.test"]);
    if ($center->provisioning_status !== 'active') {
        ProvisionCenter::dispatchSync($center->id);
        $center->refresh();
    }
    if ($center->provisioning_status !== 'active') {
        throw new RuntimeException('Fixture provisioning failed.');
    }
    foreach ($credentials as $role => $user) {
        CenterMembership::firstOrCreate(['tenant_id' => $center->id, 'user_id' => $user['id']], ['status' => 'active']);
    }
    $center->run(function () use ($credentials): void {
        DB::table('center_grants')->insertOrIgnore(['user_id' => $credentials['owner']['id'], 'role' => 'center_owner']);
        $branch = DB::table('branches')->where('slug', 'north')->value('id');
        if (! $branch) {
            $branch = DB::table('branches')->insertGetId(['name' => 'الفرع الشمالي', 'slug' => 'north', 'created_at' => now(), 'updated_at' => now()]);
        }
        DB::table('branch_grants')->insertOrIgnore(['branch_id' => $branch, 'user_id' => $credentials['staff']['id'], 'role' => 'registration']);
    });
}
$file = storage_path('app/private/issue68-browser-credentials.json');
file_put_contents($file, json_encode($credentials));
chmod($file, 0600);
