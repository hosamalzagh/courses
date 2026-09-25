<?php

namespace App\Console\Commands;

use App\Models\Center;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;
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
        $tool = config('courses.pg_bin').'/pg_restore';
        $process = new Process([
            $tool, '--clean', '--if-exists', '--single-transaction', '--no-owner', '--no-acl',
            '--host='.$connection['host'], '--port='.(string) $connection['port'],
            '--username='.$connection['username'], '--dbname='.$center->database()->getName(), $file,
        ], null, ['PGPASSWORD' => $connection['password']]);
        $process->mustRun();
        Artisan::call('courses:reconcile-grants', ['slug' => $center->slug, '--apply' => true]);
        $this->info('Restored '.$center->slug.' and reconciled its grants.');

        return self::SUCCESS;
    }
}
