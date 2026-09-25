<?php

namespace App\Http\Controllers;

use App\Models\Branch;
use App\Support\CenterPermissions;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class CenterBranchController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $permissions = $this->permissions($request);
        $query = Branch::query()->orderBy('name');

        if (! $permissions->isCenterManager()) {
            $query->whereIn('id', array_keys($permissions->branchRoles));
        }

        return response()->json(['branches' => $query->get(['id', 'name', 'slug', 'address'])]);
    }

    public function store(Request $request): JsonResponse
    {
        abort_unless($this->permissions($request)->isCenterManager(), 403);

        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'slug' => ['required', 'regex:/^[a-z][a-z0-9-]{1,62}$/', 'unique:tenant.branches,slug'],
            'address' => ['nullable', 'string', 'max:2000'],
        ]);
        $branch = DB::connection('tenant')->transaction(function () use ($request, $data): Branch {
            $branch = Branch::create($data);
            $this->audit($request, $branch, 'branch.created', $data);

            return $branch;
        });

        return response()->json(['branch' => $branch], 201);
    }

    public function show(Request $request, int $branchId): JsonResponse
    {
        $branch = Branch::findOrFail($branchId);
        abort_unless($this->permissions($request)->can('read', $branch->id), 403);

        return response()->json(['branch' => $branch]);
    }

    public function update(Request $request, int $branchId): JsonResponse
    {
        $branch = Branch::findOrFail($branchId);
        abort_unless($this->permissions($request)->can('update', $branch->id), 403);

        $data = $request->validate([
            'name' => ['sometimes', 'required', 'string', 'max:255'],
            'address' => ['sometimes', 'nullable', 'string', 'max:2000'],
        ]);
        DB::connection('tenant')->transaction(function () use ($request, $branch, $data): void {
            $branch->update($data);
            $this->audit($request, $branch, 'branch.updated', $data);
        });

        return response()->json(['branch' => $branch]);
    }

    public function auditLog(Request $request, int $branchId): JsonResponse
    {
        $branch = Branch::findOrFail($branchId);
        abort_unless($this->permissions($request)->can('audit', $branch->id), 403);

        $entries = DB::connection('tenant')->table('center_audit_logs')
            ->where('branch_id', $branch->id)
            ->orderByDesc('id')
            ->limit(50)
            ->get();

        return response()->json(['entries' => $entries]);
    }

    private function permissions(Request $request): CenterPermissions
    {
        return $request->attributes->get('center_permissions');
    }

    private function audit(Request $request, Branch $branch, string $event, array $details): void
    {
        DB::connection('tenant')->table('center_audit_logs')->insert([
            'actor_id' => $request->user()->id,
            'branch_id' => $branch->id,
            'event' => $event,
            'details' => json_encode($details),
            'created_at' => now(),
        ]);
    }
}
