<?php

namespace App\Support;

use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

class ActiveStudentRefunds
{
    public static function query(): Builder
    {
        return DB::connection('tenant')->table('student_refunds as refunds')
            ->whereNotExists(DB::connection('tenant')->table('student_refund_reversals as reversals')
                ->whereColumn('reversals.refund_id', 'refunds.id')->selectRaw('1'));
    }
}
