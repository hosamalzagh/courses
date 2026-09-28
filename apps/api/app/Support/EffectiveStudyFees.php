<?php

namespace App\Support;

class EffectiveStudyFees
{
    public static function amount(string $feeAlias): string
    {
        return "({$feeAlias}.net_amount + COALESCE((SELECT SUM(fee_adjustments.amount_delta) FROM study_fee_adjustments AS fee_adjustments WHERE fee_adjustments.fee_id = {$feeAlias}.id), 0))";
    }
}
