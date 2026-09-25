<?php

namespace App\Http\Controllers;

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
        if (! $permissions->isCenterManager()) {
            $auditableBranches = array_keys(array_filter($permissions->branchRoles,
                fn ($roles) => in_array('branch_auditor', $roles, true)));
            abort_if($auditableBranches === [], 403);
            $query->whereIn('branch_id', $auditableBranches);
        }

        return $query->orderByDesc('id')->limit(50)->get();
    }
}
