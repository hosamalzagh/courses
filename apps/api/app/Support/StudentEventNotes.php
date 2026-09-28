<?php

namespace App\Support;

use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

final class StudentEventNotes
{
    public static function visible(CenterPermissions $permissions): Builder
    {
        $read = self::branches($permissions, 'read');
        $finance = self::branches($permissions, 'finance.read');

        return DB::connection('tenant')->table('student_event_notes as notes')
            ->leftJoin('study_attempts as enrollment', function ($join): void {
                $join->on('enrollment.id', '=', 'notes.event_id')->where('notes.event_type', 'study_attempt');
            })
            ->leftJoin('study_attempt_fees as enrollment_fees', 'enrollment_fees.attempt_id', '=', 'enrollment.id')
            ->leftJoin('study_attendance_entries as attendance', function ($join): void {
                $join->on('attendance.id', '=', 'notes.event_id')->where('notes.event_type', 'like', 'attendance:%');
            })
            ->leftJoin('study_attempts as attendance_attempt', 'attendance_attempt.id', '=', 'attendance.attempt_id')
            ->leftJoin('study_sessions as session', 'session.id', '=', 'attendance.session_id')
            ->leftJoin('study_groups as attendance_group', 'attendance_group.id', '=', 'session.group_id')
            ->leftJoin('levels as attendance_level', 'attendance_level.id', '=', 'attendance_group.level_id')
            ->leftJoin('stages as attendance_stage', 'attendance_stage.id', '=', 'attendance_level.stage_id')
            ->leftJoin('courses as attendance_course', 'attendance_course.id', '=', 'attendance_stage.course_id')
            ->leftJoin('student_payments as payment', function ($join): void {
                $join->on('payment.id', '=', 'notes.event_id')->where('notes.event_type', 'payment');
            })
            ->leftJoin('student_payment_allocations as allocation', function ($join): void {
                $join->on('allocation.id', '=', 'notes.event_id')->where('notes.event_type', 'allocation');
            })
            ->where(function (Builder $query) use ($read, $finance): void {
                $query->where(function (Builder $event) use ($read): void {
                    $event->where('notes.event_type', 'study_attempt')
                        ->whereColumn('enrollment.student_id', 'notes.student_id')
                        ->whereColumn('enrollment_fees.branch_id', 'notes.branch_id')
                        ->when($read !== null, fn (Builder $rows) => $rows->whereIn('notes.branch_id', $read));
                })->orWhere(function (Builder $event) use ($read): void {
                    $event->where('notes.event_type', 'like', 'attendance:%')
                        ->whereNotNull('attendance.status')
                        ->whereRaw("notes.event_type = 'attendance:' || attendance.revision::text")
                        ->whereColumn('attendance_attempt.student_id', 'notes.student_id')
                        ->whereColumn('attendance_course.branch_id', 'notes.branch_id')
                        ->when($read !== null, fn (Builder $rows) => $rows->whereIn('notes.branch_id', $read));
                })->orWhere(function (Builder $event) use ($finance): void {
                    $event->where('notes.event_type', 'payment')
                        ->whereColumn('payment.student_id', 'notes.student_id')
                        ->whereColumn('payment.branch_id', 'notes.branch_id')
                        ->when($finance !== null, fn (Builder $rows) => $rows->whereIn('notes.branch_id', $finance));
                })->orWhere(function (Builder $event) use ($finance): void {
                    $event->where('notes.event_type', 'allocation')
                        ->whereColumn('allocation.student_id', 'notes.student_id')
                        ->whereColumn('allocation.source_branch_id', 'notes.branch_id')
                        ->when($finance !== null, fn (Builder $rows) => $rows->whereIn('notes.branch_id', $finance)
                            ->whereIn('allocation.target_branch_id', $finance));
                });
            })
            ->select(['notes.id', 'notes.event_type', 'notes.event_id', 'notes.branch_id', 'notes.body',
                'notes.important', 'notes.revision', 'notes.updated_by_name', 'notes.updated_at',
                'attendance.session_id', 'attendance_group.id as group_id'])
            ->selectRaw('COALESCE(payment.id, allocation.payment_id) as payment_id');
    }

    private static function branches(CenterPermissions $permissions, string $action): ?array
    {
        if ($permissions->isCenterManager()) {
            return null;
        }

        return array_keys(array_filter($permissions->branchRoles,
            fn (array $roles): bool => in_array($action, CenterPermissions::actions($roles), true)));
    }
}
