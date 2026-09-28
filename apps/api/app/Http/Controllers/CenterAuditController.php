<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

class CenterAuditController extends Controller
{
    public const FINANCIAL_EVENTS = ['student.payment_recorded', 'student.payment_allocated', 'student.payment_allocation_reversed',
        'student.fee_settled', 'student.fee_settlement_corrected',
        'student.payment_note_created', 'student.payment_note_updated',
        'student.allocation_note_created', 'student.allocation_note_updated'];

    public const ENROLLMENT_EVENTS = ['student.enrolled', 'student.study_repeated', 'student.study_withdrawn',
        'student.study_waitlisted', 'student.study_reattached',
        'student.study_attempt_note_created', 'student.study_attempt_note_updated'];

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
            $attendanceEvents = ['student.attendance_note_created', 'student.attendance_note_updated'];
            $attendanceBranches = array_keys(array_filter($permissions->branchRoles,
                fn ($roles) => in_array('attendance.record', CenterPermissions::actions($roles), true)
                    || in_array('attendance.correct', CenterPermissions::actions($roles), true)));
            $query->where(fn ($scope) => $scope->whereNotIn('event', [...$financialEvents, ...$enrollmentEvents, ...$attendanceEvents])
                ->orWhere(fn ($event) => $event->whereIn('event', $financialEvents)->whereIn('branch_id', $financialBranches))
                ->orWhere(fn ($event) => $event->whereIn('event', $enrollmentEvents)->whereIn('branch_id', $enrollmentBranches))
                ->orWhere(fn ($event) => $event->whereIn('event', $attendanceEvents)->whereIn('branch_id', $attendanceBranches)));
            $query->where(fn ($scope) => $scope
                ->whereNotIn('event', ['student.payment_allocated', 'student.payment_allocation_reversed',
                    'student.allocation_note_created', 'student.allocation_note_updated',
                    'student.fee_settled', 'student.fee_settlement_corrected'])
                ->orWhereNull('details->related_branch_ids')
                ->orWhereRaw("(details->'related_branch_ids')::jsonb <@ ?::jsonb",
                    [json_encode(array_map('intval', $financialBranches))]));
        }

        return self::redactCopySources($query->orderByDesc('id')->limit(50)->get(), $permissions);
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
