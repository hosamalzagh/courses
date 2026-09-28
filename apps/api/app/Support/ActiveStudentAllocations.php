<?php

namespace App\Support;

use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

class ActiveStudentAllocations
{
    public static function query(): Builder
    {
        return DB::connection('tenant')->table('student_payment_allocations as allocations')
            ->whereNotExists(DB::connection('tenant')->table('student_payment_allocation_reversals as reversals')
                ->whereColumn('reversals.allocation_id', 'allocations.id')->selectRaw('1'));
    }
}
