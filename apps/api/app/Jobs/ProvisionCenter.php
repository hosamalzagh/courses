<?php

namespace App\Jobs;

use App\Mail\CenterInvitationMail;
use App\Models\Center;
use App\Models\CenterInvitation;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use RuntimeException;
use Throwable;

class ProvisionCenter implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(public string $centerId)
    {
        $this->onQueue('platform');
    }

    public function handle(): void
    {
        $center = Center::findOrFail($this->centerId);

        if ($center->provisioning_status === 'active') {
            return;
        }

        $center->update(['provisioning_status' => 'provisioning', 'provisioning_error' => null]);

        try {
            $manager = $center->database()->manager();

            if (! $manager->databaseExists($center->database()->getName())) {
                $manager->createDatabase($center);
            }

            $center->update(['database_state' => 'available']);

            if (Artisan::call('tenants:migrate', ['--tenants' => [$center->id], '--force' => true]) !== 0) {
                throw new RuntimeException('Center migrations failed.');
            }

            $center->run(function () use ($center): void {
                $center->update([
                    'migration_version' => DB::table('migrations')->max('migration'),
                ]);
            });

            $this->inviteFirstOwner($center);

            $center->update([
                'provisioning_status' => 'active',
                'provisioned_at' => now(),
            ]);
        } catch (Throwable $exception) {
            $center->update([
                'provisioning_status' => 'failed',
                'provisioning_error' => class_basename($exception),
            ]);

            report($exception);
        } finally {
            tenancy()->end();
        }
    }

    private function inviteFirstOwner(Center $center): void
    {
        $invitation = CenterInvitation::where('tenant_id', $center->id)
            ->where('email', $center->owner_email)
            ->first();

        if ($invitation?->accepted_at) {
            return;
        }

        if (! $invitation) {
            $token = Str::random(64);
            $invitation = CenterInvitation::create([
                'tenant_id' => $center->id,
                'email' => $center->owner_email,
                'token_hash' => hash('sha256', $token),
                'token_ciphertext' => $token,
                'center_role' => 'center_owner',
                'expires_at' => now()->addDays(7),
            ]);
        }

        $url = 'http://'.$center->domains()->firstOrFail()->domain.'/invitations/'.$invitation->token_ciphertext;

        Mail::to($center->owner_email)->send(new CenterInvitationMail($center->name, $url));
    }
}
