<?php

namespace App\Console\Commands;

use App\Jobs\ProvisionCenter;
use App\Models\Center;
use App\Models\User;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use RuntimeException;

#[Signature('courses:bootstrap-local {--email=admin@courses.test} {--without-centers}')]
#[Description('Create a local platform owner and two isolated demonstration centers')]
class BootstrapLocalDemo extends Command
{
    public function handle(): int
    {
        $database = config('database.connections.central.database');
        if (! ((app()->environment('local') && $database === 'courses_central')
            || (app()->runningUnitTests() && $database === 'courses_test_central'))) {
            $this->error('This command is restricted to the local courses_central database.');

            return self::FAILURE;
        }

        $email = strtolower((string) $this->option('email'));
        if (! filter_var($email, FILTER_VALIDATE_EMAIL)) {
            $this->error('Invalid email.');

            return self::FAILURE;
        }

        $owner = User::query()->where('email', $email)->first();
        if (! $owner) {
            $password = Str::password(28);
            $path = Storage::disk('local')->path('local-platform-credentials.txt');
            $previousUmask = umask(0077);
            try {
                $file = @fopen($path, 'x');
            } finally {
                umask($previousUmask);
            }
            if ($file === false) {
                $this->error("Credentials file already exists: {$path}");

                return self::FAILURE;
            }
            try {
                $contents = "URL: http://courses.test/admin/login\nEmail: {$email}\nPassword: {$password}\n";
                $written = fwrite($file, $contents);
                fclose($file);
                if ($written !== strlen($contents) || ! chmod($path, 0600)) {
                    throw new RuntimeException('Could not save credentials securely.');
                }
                DB::connection('central')->transaction(function () use ($email, $password): void {
                    $owner = User::create(['name' => 'Local Platform Owner', 'email' => $email, 'password' => $password]);
                    $owner->platform_role = 'platform_owner';
                    $owner->email_verified_at = now();
                    $owner->save();
                });
            } catch (\Throwable $exception) {
                if (is_resource($file)) {
                    fclose($file);
                }
                unlink($path);
                throw $exception;
            }
            $this->info("Platform owner created. Credentials are in {$path}");
        } elseif ($owner->platform_role !== 'platform_owner') {
            $this->error('This email belongs to an account without the platform owner role.');

            return self::FAILURE;
        } else {
            $this->info('Platform owner already exists. Its password was not changed.');
        }

        if ($this->option('without-centers')) {
            return self::SUCCESS;
        }

        foreach (['alpha', 'beta'] as $slug) {
            $center = Center::query()->where('slug', $slug)->first();
            if (! $center) {
                $center = DB::connection('central')->transaction(function () use ($slug): Center {
                    $center = Center::create([
                        'name' => $slug === 'alpha' ? 'مركز ألفا' : 'مركز بيتا',
                        'slug' => $slug, 'plan' => 'starter',
                        'owner_email' => "{$slug}-owner@courses.test",
                    ]);
                    $center->domains()->create(['domain' => "{$slug}.courses.test"]);

                    return $center;
                });
            }
            if ($center->provisioning_status !== 'active') {
                ProvisionCenter::dispatchSync($center->id);
                $center->refresh();
            }
            if ($center->provisioning_status !== 'active') {
                throw new RuntimeException("Provisioning {$slug} failed: {$center->provisioning_error}");
            }
            $this->info("{$slug}.courses.test is active with database {$center->database()->getName()}");
        }

        return self::SUCCESS;
    }
}
