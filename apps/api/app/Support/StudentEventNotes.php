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
            ->leftJoin('study_fee_adjustments as fee_adjustment', function ($join): void {
                $join->on('fee_adjustment.id', '=', 'notes.event_id')->where('notes.event_type', 'fee_adjustment');
            })
            ->leftJoin('student_refunds as refund', function ($join): void {
                $join->on('refund.id', '=', 'notes.event_id')->where('notes.event_type', 'refund');
            })
            ->leftJoin('student_refund_reversals as refund_correction', function ($join): void {
                $join->on('refund_correction.id', '=', 'notes.event_id')->where('notes.event_type', 'refund_correction');
            })
            ->leftJoin('student_refunds as corrected_refund', 'corrected_refund.id', '=', 'refund_correction.refund_id')
            ->leftJoin('student_payment_reversals as payment_correction', function ($join): void {
                $join->on('payment_correction.id', '=', 'notes.event_id')->where('notes.event_type', 'payment_correction');
            })
            ->leftJoin('student_payments as corrected_payment', 'corrected_payment.id', '=', 'payment_correction.payment_id')
            ->leftJoin('student_payment_allocation_reversals as allocation_correction', function ($join): void {
                $join->on('allocation_correction.id', '=', 'notes.event_id')->where('notes.event_type', 'allocation_correction');
            })
            ->leftJoin('student_allocation_submissions as allocation_submission', 'allocation_submission.request_id', '=', 'allocation_correction.submission_id')
            ->leftJoin('student_payment_allocations as corrected_allocation', 'corrected_allocation.id', '=', 'allocation_correction.allocation_id')
            ->leftJoin('student_payment_allocations as replacement_allocation', 'replacement_allocation.submission_id', '=', 'allocation_correction.submission_id')
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
                })->orWhere(function (Builder $event) use ($finance): void {
                    $event->where('notes.event_type', 'fee_adjustment')
                        ->whereColumn('fee_adjustment.student_id', 'notes.student_id')
                        ->whereColumn('fee_adjustment.branch_id', 'notes.branch_id')
                        ->when($finance !== null, fn (Builder $rows) => $rows->whereIn('notes.branch_id', $finance)
                            ->whereNotExists(DB::connection('tenant')->table('study_fee_adjustment_related_branches as related')
                                ->whereColumn('related.adjustment_id', 'fee_adjustment.id')
                                ->whereNotIn('related.branch_id', $finance)->selectRaw('1')));
                })->orWhere(function (Builder $event) use ($finance): void {
                    $event->where('notes.event_type', 'refund')
                        ->whereColumn('refund.student_id', 'notes.student_id')
                        ->whereColumn('refund.branch_id', 'notes.branch_id')
                        ->when($finance !== null, fn (Builder $rows) => $rows->whereIn('notes.branch_id', $finance));
                })->orWhere(function (Builder $event) use ($finance): void {
                    $event->where('notes.event_type', 'refund_correction')
                        ->whereColumn('refund_correction.student_id', 'notes.student_id')
                        ->whereColumn('corrected_refund.branch_id', 'notes.branch_id')
                        ->when($finance !== null, fn (Builder $rows) => $rows->whereIn('notes.branch_id', $finance));
                })->orWhere(function (Builder $event) use ($finance): void {
                    $event->where('notes.event_type', 'payment_correction')
                        ->whereColumn('corrected_payment.student_id', 'notes.student_id')
                        ->whereColumn('corrected_payment.branch_id', 'notes.branch_id')
                        ->when($finance !== null, fn (Builder $rows) => $rows->whereIn('notes.branch_id', $finance)
                            ->whereNotExists(DB::connection('tenant')->table('student_payment_correction_allocations as links')
                                ->join('student_payment_allocations as original', 'original.id', '=', 'links.original_allocation_id')
                                ->whereColumn('links.payment_reversal_id', 'payment_correction.id')
                                ->whereNotIn('original.target_branch_id', $finance)->selectRaw('1')));
                })->orWhere(function (Builder $event) use ($finance): void {
                    $event->where('notes.event_type', 'allocation_correction')
                        ->whereColumn('allocation_correction.student_id', 'notes.student_id')
                        ->where('allocation_submission.kind', 'correct')
                        ->whereColumn('corrected_allocation.source_branch_id', 'notes.branch_id')
                        ->when($finance !== null, fn (Builder $rows) => $rows->whereIn('notes.branch_id', $finance)
                            ->whereIn('corrected_allocation.target_branch_id', $finance)
                            ->where(fn (Builder $visible) => $visible->whereNull('replacement_allocation.id')
                                ->orWhereIn('replacement_allocation.target_branch_id', $finance)));
                });
            })
            ->select(['notes.id', 'notes.event_type', 'notes.event_id', 'notes.branch_id', 'notes.body',
                'notes.important', 'notes.revision', 'notes.updated_by_name', 'notes.updated_at',
                'attendance.session_id', 'attendance_group.id as group_id'])
            ->selectRaw('COALESCE(payment.id, allocation.payment_id) as payment_id');
    }

    private static function branches(CenterPermissions $permissions, string $action): ?array
    {
        if ($action === 'read' && $permissions->workspace?->mode === 'branch') {
            return $permissions->can('read', $permissions->workspace->branch['id']) ? [$permissions->workspace->branch['id']] : [];
        }
        if ($permissions->isCenterManager()) {
            return null;
        }

        return array_keys(array_filter($permissions->branchRoles,
            fn (array $roles): bool => in_array($action, CenterPermissions::actions($roles), true)));
    }
}
