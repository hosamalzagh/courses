<?php

use App\Jobs\ProvisionCenter;
use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Support\Facades\DB;

if (! app()->isLocal() || getenv('COURSES_CHOICES_ISOLATED') !== '1' || (string) config('database.connections.central.port') !== '5557' || config('database.connections.central.database') !== 'courses_central') {
    throw new RuntimeException('Use the disposable student-choice database on port 5557.');
}
$credentials = [];
foreach (['alpha', 'beta'] as $slug) {
    $center = Center::create(['name' => $slug === 'alpha' ? 'مركز ألفا' : 'مركز بيتا', 'slug' => $slug, 'plan' => 'starter', 'owner_email' => "owner@{$slug}.test"]);
    $center->domains()->create(['domain' => "{$slug}.courses.test"]);
    ProvisionCenter::dispatchSync($center->id);
    $center->refresh();
    if ($center->provisioning_status !== 'active') {
        throw new RuntimeException('Provisioning failed');
    }
    $password = bin2hex(random_bytes(24));
    $owner = User::factory()->create(['name' => 'مالك القبول', 'email' => "owner@{$slug}.test", 'password' => $password]);
    CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $owner->id, 'status' => 'active']);
    $center->run(function () use ($owner) {
        DB::table('center_grants')->insert(['user_id' => $owner->id, 'role' => 'center_owner']);
        foreach (['north' => 'الفرع الشمالي', 'south' => 'الفرع الجنوبي'] as $branch => $label) {
            DB::table('branches')->insert(['name' => $label, 'slug' => $branch, 'created_at' => now(), 'updated_at' => now()]);
        }
    });
    $credentials[$slug] = ['email' => $owner->email, 'password' => $password];
    if ($slug === 'alpha') {
        $password = bin2hex(random_bytes(24));
        $staff = User::factory()->create(['name' => 'موظف القبول', 'email' => 'staff@alpha.test', 'password' => $password]);
        $membership = CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $staff->id, 'status' => 'active']);
        $center->run(fn () => DB::table('branch_grants')->insert(['user_id' => $staff->id, 'branch_id' => DB::table('branches')->where('slug', 'north')->value('id'), 'role' => 'registration']));
        $credentials['staff'] = ['email' => $staff->email, 'password' => $password, 'membership_id' => $membership->id];
    }
}
file_put_contents(storage_path('app/private/student-choices-browser-credentials.json'), json_encode($credentials));
chmod(storage_path('app/private/student-choices-browser-credentials.json'), 0600);
