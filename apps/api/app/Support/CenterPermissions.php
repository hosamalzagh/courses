<?php

namespace App\Support;

use Illuminate\Support\Facades\DB;

class CenterPermissions
{
    public function __construct(
        public array $centerRoles,
        public array $branchRoles,
    ) {}

    public static function forUser(int $userId): self
    {
        $rows = DB::connection('tenant')->table('center_grants')
            ->selectRaw('NULL::bigint AS branch_id, role')->where('user_id', $userId)
            ->unionAll(DB::connection('tenant')->table('branch_grants')
                ->select(['branch_id', 'role'])->where('user_id', $userId))
            ->get();
        $centerRoles = $rows->whereNull('branch_id')->pluck('role')->all();
        $branchRoles = $rows->whereNotNull('branch_id')->groupBy('branch_id')
            ->map(fn ($grants) => $grants->pluck('role')->all())->all();

        return new self($centerRoles, $branchRoles);
    }

    public function isCenterManager(): bool
    {
        return in_array('center_owner', $this->centerRoles, true)
            || in_array('center_admin', $this->centerRoles, true);
    }

    public function isOwner(): bool
    {
        return in_array('center_owner', $this->centerRoles, true);
    }

    public function can(string $action, int $branchId): bool
    {
        if ($this->isCenterManager()) {
            return true;
        }

        $roles = $this->branchRoles[$branchId] ?? [];

        return match ($action) {
            'read' => (bool) array_intersect($roles, ['branch_manager', 'branch_viewer', 'branch_auditor']),
            'update' => in_array('branch_manager', $roles, true),
            'audit' => in_array('branch_auditor', $roles, true),
            default => false,
        };
    }

    public function toArray(): array
    {
        return [
            'center_roles' => $this->centerRoles,
            'branch_roles' => $this->branchRoles,
            'can_manage_center' => $this->isCenterManager(),
        ];
    }
}
