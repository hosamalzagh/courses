<?php

namespace App\Console\Commands;

use App\Models\Center;
use App\Models\CenterInvitation;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

#[Signature('courses:reconcile-grants {slug} {--apply}')]
#[Description('Find or remove tenant grants without active central membership')]
class ReconcileCenterGrants extends Command
{
    public function handle(): int
    {
        $center = Center::query()->where('slug', $this->argument('slug'))->firstOrFail();
        $activeIds = CenterMembership::query()->where('tenant_id', $center->id)
            ->where('status', 'active')->pluck('user_id')->all();
        $candidate = CenterInvitation::query()->where('tenant_id', $center->id)
            ->where('center_role', 'center_owner')->whereNotNull('accepted_at')
            ->whereIn('email', User::query()->whereIn('id', $activeIds)->pluck('email'))->first();
        $candidateId = $candidate ? User::query()->where('email', $candidate->email)->value('id') : null;
        $result = $center->run(function () use ($activeIds, $candidateId): array {
            $centerGrants = DB::table('center_grants')->whereNotIn('user_id', $activeIds)->count();
            $branchGrants = DB::table('branch_grants')->whereNotIn('user_id', $activeIds)->count();
            $activeOwnerCount = DB::table('center_grants')->where('role', 'center_owner')
                ->whereIn('user_id', $activeIds)->count();
            $restoreOwner = $activeOwnerCount === 0 && $candidateId;
            if ($this->option('apply')) {
                DB::transaction(function () use ($activeIds, $restoreOwner): void {
                    DB::table('center_grants')->whereNotIn('user_id', $activeIds)->delete();
                    DB::table('branch_grants')->whereNotIn('user_id', $activeIds)->delete();
                    if ($restoreOwner) {
                        DB::table('center_grants')->updateOrInsert(
                            ['user_id' => $restoreOwner, 'role' => 'center_owner'],
                            ['created_at' => now(), 'updated_at' => now()],
                        );
                    }
                });
            }

            return [$centerGrants, $branchGrants, (bool) $restoreOwner];
        });
        $this->info("Orphan center grants: {$result[0]}; branch grants: {$result[1]}; owner repair needed: ".($result[2] ? 'yes' : 'no'));

        return self::SUCCESS;
    }
}
