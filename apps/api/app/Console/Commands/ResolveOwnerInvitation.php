<?php

namespace App\Console\Commands;

use App\Models\Center;
use App\Models\CenterInvitation;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

#[Signature('courses:resolve-owner-invitation {slug} {outcome : delivered or not-delivered}')]
#[Description('Resolve an uncertain first-owner invitation delivery after inspecting the mailbox')]
class ResolveOwnerInvitation extends Command
{
    public function handle(): int
    {
        $outcome = $this->argument('outcome');
        if (! in_array($outcome, ['delivered', 'not-delivered'], true)) {
            $this->error('Outcome must be delivered or not-delivered.');

            return self::FAILURE;
        }

        $center = Center::query()->where('slug', $this->argument('slug'))->first();
        if (! $center) {
            $this->error('Center not found.');

            return self::FAILURE;
        }

        $resolved = DB::connection('central')->transaction(function () use ($center, $outcome): bool {
            Center::query()->whereKey($center->id)->lockForUpdate()->firstOrFail();
            $invitation = CenterInvitation::query()->where('tenant_id', $center->id)
                ->where('email', $center->owner_email)->lockForUpdate()->first();
            if (! $invitation || $invitation->accepted_at || $invitation->sent_at || ! $invitation->delivery_claimed_at) {
                return false;
            }

            $invitation->update($outcome === 'delivered'
                ? ['sent_at' => now()]
                : ['delivery_claimed_at' => null]);

            return true;
        });

        if (! $resolved) {
            $this->error('No uncertain first-owner invitation delivery was found.');

            return self::FAILURE;
        }

        $this->info('Invitation delivery resolved. Retry center provisioning in Landlord.');

        return self::SUCCESS;
    }
}
