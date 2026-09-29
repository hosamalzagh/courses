<?php

namespace App\Support;

use Illuminate\Support\Facades\DB;

class StudyPeriodRequirements
{
    public static function close(string $periodId, string $groupId, string $leftOn): bool
    {
        $openedAt = DB::connection('tenant')->table('study_attempt_group_periods')
            ->where('id', $periodId)->value('created_at');
        $requirements = DB::connection('tenant')->table('study_group_requirements')
            ->where('group_id', $groupId);
        if ($leftOn < now('Africa/Cairo')->toDateString()) {
            // Period boundaries are dates. Changes on a later calendar day did not
            // apply at a backdated boundary. Requirements already approved when
            // the period was recorded remain its baseline even for retroactive joins.
            $requirements->where(fn ($query) => $query->where('created_at', '<=', $openedAt)
                ->orWhereRaw("(created_at AT TIME ZONE 'Africa/Cairo')::date <= ?::date", [$leftOn]))
                ->where(fn ($query) => $query->whereNull('retired_at')->orWhere(fn ($retired) => $retired
                    ->where('retired_at', '>', $openedAt)
                    ->whereRaw("(retired_at AT TIME ZONE 'Africa/Cairo')::date > ?::date", [$leftOn])));
        } else {
            $requirements->whereNull('retired_at');
        }
        $requiredCreditIds = $requirements->orderBy('number')
            ->get(['id', 'plan_lecture_id'])
            ->map(fn (object $requirement): string => $requirement->plan_lecture_id ?? $requirement->id)->all();

        return DB::connection('tenant')->table('study_attempt_group_periods')->where('id', $periodId)
            ->whereNull('left_on')
            ->update(['left_on' => $leftOn, 'required_credit_ids' => json_encode($requiredCreditIds)]) === 1;
    }
}
