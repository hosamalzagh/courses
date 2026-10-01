<?php

namespace App\Http\Controllers;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Support\CenterPermissions;
use App\Support\CenterWorkspace;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class CenterWorkspaceController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $data = $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $permissions = $request->attributes->get('center_permissions');
        $page = (int) ($data['page'] ?? 1);
        $branches = self::branches($permissions)->orderBy('name')->orderBy('id')
            ->offset(($page - 1) * 50)->limit(51)->get(['id', 'name', 'slug', 'address']);

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'permissions' => $permissions->toArray(), 'branches' => $branches->take(50)->values(),
            'pagination' => ['page' => $page, 'has_more' => $branches->count() > 50],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'mode' => ['required', 'in:branch,center'],
            'branch_id' => ['nullable', 'required_if:mode,branch', 'integer', 'min:1'],
            'return_to' => ['sometimes', 'string', 'max:2048'],
        ]);

        // Reload under the same membership lock used by curriculum writes.
        return DB::connection('central')->transaction(function () use ($request, $data): JsonResponse {
            $center = Center::query()->whereKey($request->attributes->get('center')->id)->lockForUpdate()->firstOrFail();
            abort_if($center->suspended, 423);
            abort_unless($center->provisioning_status === 'active', 503);
            abort_unless(CenterMembership::query()->where('tenant_id', $center->id)
                ->where('user_id', $request->user()->id)->value('status') === 'active', 403);
            $permissions = CenterPermissions::forUser($request->user()->id, false);
            if ($data['mode'] === 'center') {
                abort_unless($permissions->isCenterManager(), 403);
                $branch = null;
            } else {
                $branch = self::branches($permissions)->where('id', $data['branch_id'])->first(['id', 'name', 'slug', 'address']);
                abort_unless($branch, 403);
            }
            $workspace = CenterWorkspace::select($request, $data['mode'], $branch ? (array) $branch : null);

            return response()->json(['workspace' => $workspace->toArray(), 'destination' => $workspace->destination($data['return_to'] ?? '/admin')]);
        });
    }

    public static function branches(CenterPermissions $permissions): Builder
    {
        $query = DB::connection('tenant')->table('branches');
        if (! $permissions->isCenterManager()) {
            $query->whereIn('id', $permissions->readableBranchIds());
        }

        return $query;
    }

    public static function afterLogin(Request $request): string
    {
        $request->session()->forget(['center_workspaces', 'initial_workspace', 'workspace_required']);
        $permissions = CenterPermissions::forUser($request->user()->id, false);
        $branches = self::branches($permissions)->orderBy('id')->limit(2)->get(['id', 'name', 'slug', 'address']);
        $request->session()->put('workspace_required', true);
        if ($branches->count() === 1) {
            return CenterWorkspace::select($request, 'branch', (array) $branches->first())->destination();
        }
        if ($branches->isEmpty() && $permissions->isCenterManager()) {
            return CenterWorkspace::select($request, 'center', null)->destination('/admin/settings').'&tab=branches';
        }

        return '/admin/workspaces';
    }
}
