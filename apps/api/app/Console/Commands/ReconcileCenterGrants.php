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

#[Signature('courses:reconcile-grants {slug} {--apply} {--retain-owner=*}')]
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
            ->whereIn('email', User::query()->whereIn('id', $activeIds)->pluck('email'))
            ->orderByDesc('accepted_at')->first();
        $candidateId = $candidate ? User::query()->where('email', $candidate->email)->value('id') : null;
        $retainedOwnerIds = array_values(array_intersect(array_map('intval', $this->option('retain-owner')), $activeIds));
        $result = $center->run(function () use ($activeIds, $candidateId, $retainedOwnerIds): array {
            $centerGrants = DB::table('center_grants')->whereNotIn('user_id', $activeIds)->count();
            $branchGrants = DB::table('branch_grants')->whereNotIn('user_id', $activeIds)->count();
            $activeOwnerIds = DB::table('center_grants')->where('role', 'center_owner')
                ->whereIn('user_id', $activeIds)->pluck('user_id')->all();
            $restoreOwnerIds = array_values(array_diff($retainedOwnerIds, $activeOwnerIds));
            if ($activeOwnerIds === [] && $restoreOwnerIds === [] && $candidateId) {
                $restoreOwnerIds = [$candidateId];
            }
            if ($this->option('apply')) {
                DB::transaction(function () use ($activeIds, $restoreOwnerIds): void {
                    DB::table('center_grants')->whereNotIn('user_id', $activeIds)->delete();
                    DB::table('branch_grants')->whereNotIn('user_id', $activeIds)->delete();
                    foreach ($restoreOwnerIds as $restoreOwnerId) {
                        DB::table('center_grants')->updateOrInsert(
                            ['user_id' => $restoreOwnerId, 'role' => 'center_owner'],
                            ['created_at' => now(), 'updated_at' => now()],
                        );
                    }
                });
            }

            return [$centerGrants, $branchGrants, count($restoreOwnerIds)];
        });
        $this->info("Orphan center grants: {$result[0]}; branch grants: {$result[1]}; owners to restore: {$result[2]}");

        return self::SUCCESS;
    }
}
