<?php

namespace App\Support;

use Illuminate\Support\Facades\DB;

class StudyPeriodRequirements
{
    public static function close(string $periodId, string $groupId, string $leftOn): void
    {
        $requiredCreditIds = DB::connection('tenant')->table('study_group_requirements')
            ->where('group_id', $groupId)->whereNull('retired_at')->orderBy('number')
            ->get(['id', 'plan_lecture_id'])
            ->map(fn (object $requirement): string => $requirement->plan_lecture_id ?? $requirement->id)->all();
        DB::connection('tenant')->table('study_attempt_group_periods')->where('id', $periodId)
            ->update(['left_on' => $leftOn, 'required_credit_ids' => json_encode($requiredCreditIds)]);
    }
}
