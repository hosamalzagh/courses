<?php

namespace App\Console\Commands;

use App\Models\Center;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Symfony\Component\Process\Process;

#[Signature('courses:backup {slug}')]
#[Description('Back up one local center database without touching other centers')]
class CenterBackup extends Command
{
    public function handle(): int
    {
        if (! app()->environment(['local', 'testing'])) {
            $this->error('Local backups only.');

            return self::FAILURE;
        }
        $center = Center::query()->where('slug', $this->argument('slug'))->firstOrFail();
        abort_unless($center->provisioning_status === 'active', 409);
        $directory = storage_path('app/private/backups');
        if (! is_dir($directory)) {
            mkdir($directory, 0700, true);
        }
        $file = $directory.'/'.$center->slug.'-'.$center->id.'-'.now()->format('YmdHis').'.dump';
        $connection = config('database.connections.central');
        $tool = config('courses.pg_bin').'/pg_dump';
        $process = new Process([
            $tool, '--format=custom', '--no-owner', '--no-acl', '--file='.$file,
            '--host='.$connection['host'], '--port='.(string) $connection['port'],
            '--username='.$connection['username'], $center->database()->getName(),
        ], null, ['PGPASSWORD' => $connection['password']]);
        $process->mustRun();
        chmod($file, 0600);
        $this->info($file);

        return self::SUCCESS;
    }
}
