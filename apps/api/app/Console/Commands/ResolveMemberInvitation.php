<?php

namespace App\Console\Commands;

use App\Models\Center;
use App\Models\CenterInvitation;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

#[Signature('courses:resolve-member-invitation {slug} {email} {outcome : delivered or not-delivered}')]
#[Description('Resolve uncertain staff invitation delivery after inspecting the mailbox')]
class ResolveMemberInvitation extends Command
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

        $email = strtolower(trim($this->argument('email')));
        $resolved = DB::connection('central')->transaction(function () use ($center, $email, $outcome): bool {
            Center::query()->whereKey($center->id)->lockForUpdate()->firstOrFail();
            $invitation = CenterInvitation::query()->where('tenant_id', $center->id)
                ->where('email', $email)->lockForUpdate()->first();
            if (! $invitation || $invitation->accepted_at || $invitation->sent_at || ! $invitation->delivery_claimed_at) {
                return false;
            }

            $invitation->update($outcome === 'delivered'
                ? ['sent_at' => now()]
                : ['delivery_claimed_at' => null]);

            return true;
        });

        if (! $resolved) {
            $this->error('No uncertain member invitation delivery was found.');

            return self::FAILURE;
        }

        $this->info('Invitation delivery resolved. The center manager can retry if not delivered.');

        return self::SUCCESS;
    }
}
