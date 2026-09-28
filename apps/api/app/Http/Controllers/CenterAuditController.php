<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

class CenterAuditController extends Controller
{
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
            $query->where(fn ($scope) => $scope->whereNotIn('event', ['student.payment_recorded', 'student.enrolled'])
                ->orWhere(fn ($event) => $event->where('event', 'student.payment_recorded')->whereIn('branch_id', $financialBranches))
                ->orWhere(fn ($event) => $event->where('event', 'student.enrolled')->whereIn('branch_id', $enrollmentBranches)));
        }

        return $query->orderByDesc('id')->limit(50)->get();
    }
}
