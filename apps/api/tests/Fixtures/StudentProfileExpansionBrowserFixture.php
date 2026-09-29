<?php

use App\Jobs\ProvisionCenter;
use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;

require __DIR__.'/../../vendor/autoload.php';
$app = require __DIR__.'/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();

if (! app()->isLocal() || getenv('COURSES_BROWSER_ISOLATED') !== '1'
    || config('database.connections.central.database') !== 'courses_issue35_browser'
    || config('database.connections.central.host') !== '127.0.0.1'
    || (string) config('database.connections.central.port') !== '5558') {
    throw new RuntimeException('Issue #82 requires its isolated browser PostgreSQL database on port 5558.');
}

$alpha = Center::where('slug', 'alpha')->firstOrFail();
if ($alpha->provisioning_status !== 'active' || Center::whereNotIn('slug', ['alpha', 'beta'])->exists()) {
    throw new RuntimeException('Unexpected centers in the isolated issue #82 fixture.');
}

$snapshot = static function (Center $center): string {
    return $center->run(static fn (): string => json_encode([
        'students' => DB::table('students')->orderBy('id')->get(['id', 'student_number', 'phone', 'request_id', 'status']),
        'branches' => DB::table('student_branches')->orderBy('student_id')->orderBy('branch_id')->get(['student_id', 'branch_id']),
        'audit_ids' => DB::table('center_audit_logs')->orderBy('id')->pluck('id'),
        'payment_ids' => DB::table('student_payments')->orderBy('id')->pluck('id'),
    ], JSON_THROW_ON_ERROR));
};
$alphaBefore = $snapshot($alpha);

$beta = Center::firstOrCreate(['slug' => 'beta'], [
    'name' => 'مركز قبول التوسعة بيتا', 'plan' => 'starter', 'owner_email' => 'beta-owner@issue82.test',
]);
$beta->domains()->firstOrCreate(['domain' => 'beta.courses.test']);
if ($beta->provisioning_status !== 'active') {
    ProvisionCenter::dispatchSync($beta->id);
    $beta->refresh();
}
if ($beta->provisioning_status !== 'active') {
    throw new RuntimeException('Could not provision isolated beta center.');
}

$credentials = json_decode(file_get_contents(storage_path('app/private/issue35-browser-credentials.json')), true, flags: JSON_THROW_ON_ERROR);
$sharedOwner = User::findOrFail($credentials['alpha']['id']);
if ($sharedOwner->email !== $credentials['alpha']['email']) {
    throw new RuntimeException('Shared owner fixture identity changed.');
}
CenterMembership::firstOrCreate(['tenant_id' => $beta->id, 'user_id' => $sharedOwner->id], ['status' => 'active']);
$beta->run(static function () use ($sharedOwner): void {
    DB::table('center_grants')->insertOrIgnore(['user_id' => $sharedOwner->id, 'role' => 'center_owner']);
    DB::table('branches')->insertOrIgnore([
        'slug' => 'east', 'name' => 'فرع بيتا', 'created_at' => now(), 'updated_at' => now(),
    ]);
});

for ($run = 1; $run <= 2; $run++) {
    if (Artisan::call('courses:migrate-centers') !== 0) {
        throw new RuntimeException("Isolated center migration run {$run} failed.");
    }
    $alpha->refresh();
    $beta->refresh();
    if ($snapshot($alpha) !== $alphaBefore || $alpha->migration_version !== $beta->migration_version) {
        throw new RuntimeException("Existing center data or migration version changed on run {$run}.");
    }
}

echo json_encode(['existing_center' => $alpha->id, 'new_center' => $beta->id,
    'migration_version' => $alpha->migration_version,
    'repeat_runs' => 2, 'existing_student_count' => count(json_decode($alphaBefore, true)['students']),
    'new_center_student_count' => $beta->run(static fn (): int => DB::table('students')->count())], JSON_THROW_ON_ERROR).PHP_EOL;
