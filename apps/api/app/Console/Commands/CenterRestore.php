<?php

namespace App\Console\Commands;

use App\Models\Center;
use App\Support\CenterAuditDelivery;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Symfony\Component\Process\Process;

#[Signature('courses:restore {slug} {file} {--confirm=}')]
#[Description('Restore only one local center database and reconcile its grants')]
class CenterRestore extends Command
{
    public function handle(): int
    {
        if (! app()->environment(['local', 'testing']) || $this->option('confirm') !== $this->argument('slug')) {
            $this->error('Local restore requires --confirm matching the center slug.');

            return self::FAILURE;
        }
        $center = Center::query()->where('slug', $this->argument('slug'))->firstOrFail();
        $file = realpath((string) $this->argument('file'));
        $directory = realpath(storage_path('app/private/backups'));
        if (! $file || ! $directory || dirname($file) !== $directory
            || ! str_starts_with(basename($file), $center->slug.'-'.$center->id.'-')
            || ! str_ends_with($file, '.dump')) {
            $this->error('The file must be a backup for this exact center in storage/app/private/backups.');

            return self::FAILURE;
        }

        $connection = config('database.connections.central');
        $activeMemberIds = DB::connection('central')->table('center_memberships')
            ->where('tenant_id', $center->id)->where('status', 'active')->pluck('user_id')->all();
        $currentOwnerIds = $center->run(fn () => DB::table('center_grants')
            ->where('role', 'center_owner')->whereIn('user_id', $activeMemberIds)->pluck('user_id')->all());
        $tool = config('courses.pg_bin').'/pg_restore';
        $process = new Process([
            $tool, '--clean', '--if-exists', '--single-transaction', '--no-owner', '--no-acl',
            '--host='.$connection['host'], '--port='.(string) $connection['port'],
            '--username='.$connection['username'], '--dbname='.$center->database()->getName(), $file,
        ], null, ['PGPASSWORD' => $connection['password']]);
        $process->mustRun();
        if (Artisan::call('tenants:migrate', ['--tenants' => [$center->id], '--force' => true]) !== 0) {
            throw new RuntimeException('Restored center migrations failed.');
        }
        $center->refreshMigrationVersion();
        if (Artisan::call('courses:reconcile-grants', [
            'slug' => $center->slug, '--apply' => true, '--retain-owner' => $currentOwnerIds,
            '--invalidate-versions' => true,
        ]) !== 0) {
            throw new RuntimeException('Restored center grant reconciliation failed.');
        }
        CenterAuditDelivery::replayForCenter($center->id);
        $this->info('Restored '.$center->slug.' and reconciled its grants.');

        return self::SUCCESS;
    }
}
