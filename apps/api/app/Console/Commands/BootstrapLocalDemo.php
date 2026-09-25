<?php

namespace App\Console\Commands;

use App\Jobs\ProvisionCenter;
use App\Models\Center;
use App\Models\User;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use RuntimeException;

#[Signature('courses:bootstrap-local {--email=admin@courses.test}')]
#[Description('Create a local platform owner and two isolated demonstration centers')]
class BootstrapLocalDemo extends Command
{
    public function handle(): int
    {
        if (! app()->environment('local') || config('database.connections.central.database') !== 'courses_central') {
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
            $owner = User::create(['name' => 'Local Platform Owner', 'email' => $email, 'password' => $password]);
            $owner->platform_role = 'platform_owner';
            $owner->email_verified_at = now();
            $owner->save();
            $path = storage_path('app/private/local-platform-credentials.txt');
            file_put_contents($path, "URL: http://courses.test/admin/login\nEmail: {$email}\nPassword: {$password}\n");
            chmod($path, 0600);
            $this->info("Platform owner created. Credentials are in {$path}");
        } else {
            $this->info('Platform owner already exists. Its password was not changed.');
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
