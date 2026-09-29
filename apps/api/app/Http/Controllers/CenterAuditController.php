<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

class CenterAuditController extends Controller
{
    public const FINANCIAL_EVENTS = ['student.payment_recorded', 'student.payment_corrected', 'student.payment_allocated', 'student.payment_allocation_reversed',
        'student.payment_allocation_corrected',
        'student.refund_recorded', 'student.refund_corrected',
        'student.fee_settled', 'student.fee_settlement_corrected',
        'student.payment_note_created', 'student.payment_note_updated',
        'student.allocation_note_created', 'student.allocation_note_updated',
        'student.allocation_correction_note_created', 'student.allocation_correction_note_updated',
        'student.fee_adjustment_note_created', 'student.fee_adjustment_note_updated',
        'student.refund_note_created', 'student.refund_note_updated',
        'student.refund_correction_note_created', 'student.refund_correction_note_updated',
        'student.payment_correction_note_created', 'student.payment_correction_note_updated'];

    public const ENROLLMENT_EVENTS = ['student.enrolled', 'student.study_repeated', 'student.study_withdrawn',
        'student.study_waitlisted', 'student.study_reattached', 'student.study_transferred', 'student.study_bulk_waitlist_skipped',
        'student.study_attempt_note_created', 'student.study_attempt_note_updated'];

    public const ACADEMIC_EVENTS = ['study_attempts.completion_threshold_applied'];

    public function index(Request $request): JsonResponse
    {
        return response()->json(['entries' => self::visibleEntries($request)])
            ->header('Cache-Control', 'private, no-store');
    }

    public static function visibleEntries(Request $request): Collection
    {
        $permissions = $request->attributes->get('center_permissions');
        $query = DB::connection('tenant')->table('center_audit_logs');
        if ($permissions->isCenterManager()) {
            $query->whereNotIn('event', ['member.branch_grants_changed', 'member.branch_status_changed']);
        } else {
            $auditableBranches = array_keys(array_filter($permissions->branchRoles,
                fn ($roles) => in_array('branch_auditor', $roles, true)));
            abort_if($auditableBranches === [], 403);
            $query->whereIn('branch_id', $auditableBranches);
            $financialBranches = array_keys(array_filter($permissions->branchRoles,
                fn ($roles) => in_array('finance.read', CenterPermissions::actions($roles), true)));
            $enrollmentBranches = array_keys(array_filter($permissions->branchRoles,
                fn ($roles) => in_array('enrollment.manage', CenterPermissions::actions($roles), true)));
            $financialEvents = self::FINANCIAL_EVENTS;
            $enrollmentEvents = self::ENROLLMENT_EVENTS;
            $academicEvents = self::ACADEMIC_EVENTS;
            $academicBranches = array_keys(array_filter($permissions->branchRoles,
                fn ($roles) => in_array('curriculum.manage', CenterPermissions::actions($roles), true)));
            $attendanceEvents = ['student.attendance_note_created', 'student.attendance_note_updated'];
            $attendanceBranches = array_keys(array_filter($permissions->branchRoles,
                fn ($roles) => in_array('attendance.record', CenterPermissions::actions($roles), true)
                    || in_array('attendance.correct', CenterPermissions::actions($roles), true)));
            $query->where(fn ($scope) => $scope->whereNotIn('event', [...$financialEvents, ...$enrollmentEvents, ...$academicEvents, ...$attendanceEvents])
                ->orWhere(fn ($event) => $event->whereIn('event', $financialEvents)->whereIn('branch_id', $financialBranches))
                ->orWhere(fn ($event) => $event->whereIn('event', $enrollmentEvents)->whereIn('branch_id', $enrollmentBranches))
                ->orWhere(fn ($event) => $event->whereIn('event', $academicEvents)->whereIn('branch_id', $academicBranches))
                ->orWhere(fn ($event) => $event->whereIn('event', $attendanceEvents)->whereIn('branch_id', $attendanceBranches)));
            self::scopeRelatedBranchVisibility($query, $financialBranches);
        }

        return self::redactCopySources($query->orderByDesc('id')->limit(50)->get(), $permissions);
    }

    public static function scopeRelatedBranchVisibility(Builder $query, array $financialBranches): void
    {
        $query->where(fn ($scope) => $scope
            ->whereNotIn('event', ['student.payment_corrected', 'student.payment_allocated', 'student.payment_allocation_reversed',
                'student.payment_allocation_corrected',
                'student.allocation_note_created', 'student.allocation_note_updated',
                'student.allocation_correction_note_created', 'student.allocation_correction_note_updated',
                'student.payment_correction_note_created', 'student.payment_correction_note_updated',
                'student.fee_adjustment_note_created', 'student.fee_adjustment_note_updated',
                'student.fee_settled', 'student.fee_settlement_corrected'])
            ->orWhereNull('details->related_branch_ids')
            ->orWhereRaw("(details->'related_branch_ids')::jsonb <@ ?::jsonb",
                [json_encode(array_map('intval', $financialBranches))]));
        // Notes written before related_branch_ids were recorded still need the fee adjustment's source scope.
        $query->whereNotExists(DB::connection('tenant')->table('study_fee_adjustment_related_branches as related')
            ->whereIn('center_audit_logs.event', ['student.fee_adjustment_note_created', 'student.fee_adjustment_note_updated'])
            ->whereRaw("related.adjustment_id::text = center_audit_logs.details->>'event_id'")
            ->whereNotIn('related.branch_id', $financialBranches)->selectRaw('1'));
    }

    public static function redactCopySources(Collection $entries, CenterPermissions $permissions): Collection
    {
        return $entries->map(function (object $entry) use ($permissions): object {
            if ($entry->event === 'curriculum.course_copied') {
                $details = json_decode($entry->details, true);
                if (is_array($details) && isset($details['source_branch_id'])
                    && ! $permissions->can('read', (int) $details['source_branch_id'])) {
                    unset($details['source_course_id'], $details['source_course_name'],
                        $details['source_branch_id'], $details['source_branch_name']);
                    $details['source_hidden'] = true;
                    $entry->details = json_encode($details);
                }
            }

            return $entry;
        });
    }
}
