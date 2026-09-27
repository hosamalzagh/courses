<?php

use App\Jobs\ProvisionCenter;
use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

require __DIR__.'/../../../api/vendor/autoload.php';
$app = require __DIR__.'/../../../api/bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
if (! $app->isLocal() || config('database.connections.central.database') !== 'courses_issue67_browser' || (int) config('database.connections.central.port') !== (int) getenv('COURSES_SHARING_DB_PORT') || getenv('COURSES_SHARING_DB_PORT') === false) {
    throw new RuntimeException('Use an isolated local PostgreSQL cluster with an explicit COURSES_SHARING_DB_PORT.');
}
$users = [];
foreach (['owner', 'staff'] as $role) {
    $email = "issue67-{$role}@sharing.test";
    $password = Str::password(28);
    $user = User::updateOrCreate(['email' => $email], ['name' => "Sharing {$role}", 'password' => $password, 'email_verified_at' => now()]);
    $user->markEmailAsVerified();
    $users[$role] = ['id' => $user->id, 'email' => $email, 'password' => $password];
}
foreach (['issue67-alpha', 'issue67-beta'] as $slug) {
    $center = Center::firstOrCreate(['slug' => $slug], ['name' => $slug, 'plan' => 'starter', 'owner_email' => $users['owner']['email']]);
    $center->domains()->firstOrCreate(['domain' => "{$slug}.courses.test"]);
    (new ProvisionCenter($center->id))->handle();
    if ($center->fresh()->provisioning_status !== 'active') {
        throw new RuntimeException('Sharing fixture center could not be provisioned.');
    }
    foreach ($users as $role => $user) {
        CenterMembership::firstOrCreate(['tenant_id' => $center->id, 'user_id' => $user['id']], ['status' => 'active']);
    }
    $center->run(fn () => DB::table('center_grants')->insertOrIgnore(['user_id' => $users['owner']['id'], 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now()]));
}
$path = getenv('COURSES_SHARING_CREDENTIALS');
if (! $path) {
    throw new RuntimeException('Provide a private fixture credential path.');
}
file_put_contents($path, json_encode($users));
chmod($path, 0600);
