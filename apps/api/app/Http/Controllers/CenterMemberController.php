<?php

namespace App\Http\Controllers;

use App\Mail\CenterInvitationMail;
use App\Models\Center;
use App\Models\CenterInvitation;
use App\Models\CenterMembership;
use App\Support\CenterAuditDelivery;
use App\Support\CenterPermissions;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use RuntimeException;
use Throwable;

class CenterMemberController extends Controller
{
    public function workspace(Request $request): JsonResponse
    {
        $permissions = $this->requireManager($request);
        $center = $request->attributes->get('center');
        $pages = [];
        foreach (['members', 'invitations', 'branches'] as $section) {
            $pages[$section] = max(1, min(100000, (int) $request->query($section.'_page', 1)));
        }
        $people = collect(DB::connection('central')->select(<<<'SQL'
            (SELECT m.id, m.user_id, u.name, u.email, m.status,
                NULL::bigint AS invitation_id, NULL::varchar AS center_role, NULL::timestamp AS expires_at,
                NULL::timestamp AS delivery_claimed_at, NULL::timestamp AS sent_at
            FROM center_memberships m JOIN users u ON u.id = m.user_id
            WHERE m.tenant_id = ? ORDER BY m.id LIMIT 51 OFFSET ?)
            UNION ALL
            (SELECT NULL::bigint, NULL::bigint, NULL::varchar, i.email, 'invited'::varchar,
                i.id, i.center_role, i.expires_at, i.delivery_claimed_at, i.sent_at
            FROM center_invitations i
            WHERE i.tenant_id = ? AND i.accepted_at IS NULL ORDER BY i.id LIMIT 51 OFFSET ?)
        SQL, [$center->id, ($pages['members'] - 1) * 50, $center->id, ($pages['invitations'] - 1) * 50]));
        $memberRows = $people->whereNull('invitation_id');
        $invitationRows = $people->whereNotNull('invitation_id');
        $hasMoreMembers = $memberRows->count() > 50;
        $hasMoreInvitations = $invitationRows->count() > 50;
        $people = $memberRows->take(50)->concat($invitationRows->take(50));
        $userIds = $memberRows->take(50)->pluck('user_id')->map(fn ($id) => (int) $id)->implode(',') ?: 'NULL';
        $tenantRows = DB::connection('tenant')->select(<<<SQL
            WITH visible_branches AS (SELECT id, name, slug, address FROM branches ORDER BY name COLLATE "C", id LIMIT 51 OFFSET ?),
                 editable_branches AS (SELECT id FROM visible_branches ORDER BY name COLLATE "C", id LIMIT 50)
            SELECT 'branch'::text AS kind, b.id AS branch_id, NULL::bigint AS user_id,
                NULL::text AS role, b.name::text AS name, b.slug::text AS slug, b.address::text AS address
            FROM visible_branches b
            UNION ALL
            SELECT 'center_grant', NULL::bigint, user_id, role, NULL::text, NULL::text, NULL::text
            FROM center_grants WHERE user_id IN ({$userIds})
            UNION ALL
            SELECT 'branch_grant', branch_id, user_id, role, NULL::text, NULL::text, NULL::text
            FROM branch_grants WHERE user_id IN ({$userIds}) AND branch_id IN (SELECT id FROM editable_branches)
        SQL, [($pages['branches'] - 1) * 50]);
        $branches = [];
        $centerRoles = [];
        $branchRoles = [];
        foreach ($tenantRows as $row) {
            if ($row->kind === 'branch') {
                $branches[] = ['id' => $row->branch_id, 'name' => $row->name, 'slug' => $row->slug, 'address' => $row->address];
            } elseif ($row->kind === 'center_grant') {
                $centerRoles[$row->user_id][] = $row->role;
            } else {
                $branchRoles[$row->user_id][$row->branch_id][] = $row->role;
            }
        }
        usort($branches, fn ($a, $b) => strcmp($a['name'], $b['name']) ?: $a['id'] <=> $b['id']);
        $hasMoreBranches = count($branches) > 50;
        $branches = array_slice($branches, 0, 50);
        $members = [];
        $invitations = [];
        foreach ($people as $person) {
            if ($person->invitation_id) {
                $expiresAt = Carbon::parse($person->expires_at);
                $invitations[] = [
                    'id' => $person->invitation_id, 'email' => $person->email,
                    'center_role' => $person->center_role, 'expires_at' => $expiresAt->toISOString(),
                    'status' => $this->invitationStatus(
                        $expiresAt,
                        $person->delivery_claimed_at ? Carbon::parse($person->delivery_claimed_at) : null,
                        $person->sent_at ? Carbon::parse($person->sent_at) : null,
                    ),
                ];
            } else {
                $members[] = [
                    'id' => $person->id,
                    'user' => ['id' => $person->user_id, 'name' => $person->name, 'email' => $person->email],
                    'status' => $person->status,
                    'center_roles' => $centerRoles[$person->user_id] ?? [],
                    'branch_roles' => $branchRoles[$person->user_id] ?? (object) [],
                    'grant_revision' => CenterPermissions::revision($centerRoles[$person->user_id] ?? [], $branchRoles[$person->user_id] ?? []),
                ];
            }
        }

        return response()->json([
            'user' => [
                ...$request->user()->only(['id', 'name', 'email']),
                'permissions' => $permissions->toArray(),
            ],
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'permissions' => $permissions->toArray(),
            'center' => $center->only(['id', 'name', 'slug']),
            'branches' => $branches,
            'members' => $members,
            'invitations' => $invitations,
            'grant_options' => CenterPermissions::GRANTS,
            'pagination' => [
                'members' => ['page' => $pages['members'], 'has_more' => $hasMoreMembers],
                'invitations' => ['page' => $pages['invitations'], 'has_more' => $hasMoreInvitations],
                'branches' => ['page' => $pages['branches'], 'has_more' => $hasMoreBranches],
            ],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function index(Request $request): JsonResponse
    {
        return $this->workspace($request);
    }

    public function invite(Request $request): JsonResponse
    {
        $this->requireManager($request);
        $data = $request->validate([
            'email' => ['required', 'email', 'max:255'],
            'center_role' => ['nullable', Rule::in(['center_admin'])],
            'platform_role' => ['prohibited'],
        ]);

        $center = $request->attributes->get('center');
        $email = strtolower($data['email']);
        abort_if(CenterMembership::query()->where('tenant_id', $center->id)
            ->whereHas('user', fn ($query) => $query->whereRaw('LOWER(email) = ?', [$email]))
            ->where('status', 'active')->exists(), 409);

        [$invitation, $auditId, $delivery] = DB::connection('central')->transaction(function () use ($request, $center, $email, $data): array {
            Center::query()->whereKey($center->id)->lockForUpdate()->firstOrFail();
            $permissions = $this->assertCurrentManager($request);
            abort_if(isset($data['center_role']) && ! $permissions->isOwner(), 403);
            abort_if(CenterMembership::query()->where('tenant_id', $center->id)
                ->whereHas('user', fn ($query) => $query->whereRaw('LOWER(email) = ?', [$email]))
                ->where('status', 'active')->exists(), 409);
            $invitation = CenterInvitation::query()->where('tenant_id', $center->id)
                ->where('email', $email)->lockForUpdate()->first();

            if ($invitation && ! $invitation->accepted_at && $invitation->sent_at && $invitation->expires_at->isFuture()) {
                if ($invitation->center_role !== ($data['center_role'] ?? null)) {
                    $invitation->update(['center_role' => $data['center_role'] ?? null]);
                    $auditId = CenterAuditDelivery::record($center->id, $request->user()->id,
                        'member.invitation_role_changed', ['email' => $email, 'center_role' => $invitation->center_role]);

                    return [$invitation, $auditId, 'role_updated'];
                }

                return [$invitation, null, 'sent'];
            }
            if ($invitation?->delivery_claimed_at && ! $invitation->sent_at) {
                return [$invitation, null, 'uncertain'];
            }

            if (! $invitation || $invitation->accepted_at || $invitation->expires_at->isPast()) {
                $token = Str::random(64);
                $attributes = [
                    'token_hash' => hash('sha256', $token), 'token_ciphertext' => $token,
                    'expires_at' => now()->addDays(7), 'accepted_at' => null,
                ];
                if ($invitation) {
                    $invitation->update($attributes);
                } else {
                    $invitation = CenterInvitation::create([
                        'tenant_id' => $center->id, 'email' => $email, ...$attributes,
                    ]);
                }
            }
            $invitation->update([
                'center_role' => $data['center_role'] ?? null,
                'delivery_claimed_at' => now(), 'sent_at' => null,
            ]);
            $auditId = CenterAuditDelivery::record($center->id, $request->user()->id,
                'member.invited', ['email' => $email, 'center_role' => $invitation->center_role]);

            return [$invitation, $auditId, 'send'];
        });
        if ($delivery === 'uncertain') {
            return response()->json(['code' => 'invitation_delivery_uncertain'], 409);
        }
        if ($delivery === 'sent') {
            return response()->json(['status' => 'already_sent', 'invitation' => $this->invitationPayload($invitation)], 200);
        }
        if ($delivery === 'role_updated') {
            CenterAuditDelivery::tryDeliver($auditId);

            return response()->json(['status' => 'role_updated', 'invitation' => $this->invitationPayload($invitation)], 200);
        }

        CenterAuditDelivery::tryDeliver($auditId);
        try {
            Mail::to($email)->send(new CenterInvitationMail(
                $center->name, 'http://'.$request->getHost().'/invitations/'.$invitation->token_ciphertext,
            ));
            $invitation->update(['sent_at' => now()]);
        } catch (Throwable $exception) {
            report($exception);

            return response()->json(['code' => 'invitation_delivery_uncertain'], 409);
        }

        return response()->json(['status' => 'sent', 'invitation' => $this->invitationPayload($invitation)], 201);
    }

    public function updateStatus(Request $request, CenterMembership $membership): JsonResponse
    {
        $this->requireManager($request);
        $this->assertSameCenter($request, $membership);
        $data = $request->validate(['status' => ['required', Rule::in(['active', 'suspended'])]]);
        $auditIds = DB::connection('central')->transaction(function () use ($membership, $data, $request): array {
            $this->lockCenter($membership);
            $this->assertCurrentManager($request);
            $membership->refresh();
            if ($data['status'] === 'suspended') {
                $this->protectLastOwner($membership);
            }
            $membership->update(['status' => $data['status']]);

            $details = ['user_id' => $membership->user_id, 'status' => $data['status']];
            $auditIds = [CenterAuditDelivery::record($membership->tenant_id, $request->user()->id,
                'member.status_changed', $details)];
            $branchIds = DB::connection('tenant')->table('branch_grants')
                ->where('user_id', $membership->user_id)->distinct()->pluck('branch_id');
            foreach ($branchIds as $branchId) {
                $auditIds[] = CenterAuditDelivery::record($membership->tenant_id, $request->user()->id,
                    'member.branch_status_changed', $details, (int) $branchId);
            }

            return $auditIds;
        });
        foreach ($auditIds as $auditId) {
            CenterAuditDelivery::tryDeliver($auditId);
        }

        return response()->json(['status' => $membership->status]);
    }

    private function invitationStatus(Carbon $expiresAt, ?Carbon $deliveryClaimedAt, ?Carbon $sentAt): string
    {
        if ($deliveryClaimedAt && ! $sentAt) {
            return 'uncertain';
        }
        if (! $sentAt) {
            return 'not_sent';
        }

        return $expiresAt->isPast() ? 'expired' : 'pending';
    }

    private function invitationPayload(CenterInvitation $invitation): array
    {
        return [
            ...$invitation->only(['id', 'email', 'center_role', 'expires_at']),
            'status' => $this->invitationStatus($invitation->expires_at, $invitation->delivery_claimed_at, $invitation->sent_at),
        ];
    }

    public function updateGrants(Request $request, CenterMembership $membership): JsonResponse
    {
        $this->requireManager($request);
        $this->assertSameCenter($request, $membership);
        $data = $request->validate([
            'center_roles' => ['present', 'array'],
            'center_roles.*' => [Rule::in(['center_owner', 'center_admin'])],
            'branch_roles' => ['present', 'array'],
            'branch_roles.*' => ['array'],
            'branch_roles.*.*' => [Rule::in(array_keys(CenterPermissions::GRANTS))],
            'platform_role' => ['prohibited'],
            'grant_revision' => ['sometimes', 'string', 'size:64'],
            'branch_scope' => ['sometimes', 'array', 'max:50'],
            'branch_scope.*' => ['integer', 'distinct'],
        ]);
        // Keep the center row locked until the tenant grants commit. Otherwise two
        // owners can concurrently remove themselves after each sees the other.
        $tenantCommitted = false;
        try {
            DB::connection('central')->transaction(function () use ($membership, $data, $request, &$tenantCommitted): void {
                $this->lockCenter($membership);
                $permissions = $this->assertCurrentManager($request);
                DB::connection('tenant')->transaction(function () use ($membership, $data, $permissions, $request): void {
                    $membership->refresh();
                    $centerRoles = array_values(array_unique($data['center_roles']));
                    $currentCenterRoles = DB::connection('tenant')->table('center_grants')
                        ->where('user_id', $membership->user_id)->pluck('role')->all();
                    $targetIsOwner = in_array('center_owner', $currentCenterRoles, true);
                    abort_if($targetIsOwner && ! $permissions->isOwner(), 403);
                    abort_if(in_array('center_owner', $centerRoles, true) && ! $permissions->isOwner(), 403);
                    $adminRoleChanges = in_array('center_admin', $currentCenterRoles, true)
                        !== in_array('center_admin', $centerRoles, true);
                    abort_if($adminRoleChanges && ! $permissions->isOwner(), 403);
                    if (! in_array('center_owner', $centerRoles, true)) {
                        $this->protectLastOwner($membership);
                    }

                    $branchIds = array_map('intval', array_keys($data['branch_roles']));
                    $validIds = DB::connection('tenant')->table('branches')->whereIn('id', $branchIds)->pluck('id')->all();
                    abort_unless(count($validIds) === count($branchIds), 422);

                    $previousBranchRoles = DB::connection('tenant')->table('branch_grants')
                        ->where('user_id', $membership->user_id)->get(['branch_id', 'role'])
                        ->groupBy('branch_id')->map(fn ($grants) => $grants->pluck('role')->all())->all();

                    $scope = $data['branch_scope'] ?? null;
                    if ($scope !== null) {
                        abort_unless(array_diff($branchIds, $scope) === [], 422);
                        $previousBranchRoles = array_intersect_key($previousBranchRoles, array_flip($scope));
                    }
                    $nextBranchRoles = array_filter(array_map(
                        fn (array $roles): array => array_values(array_unique($roles)), $data['branch_roles'],
                    ));
                    foreach ($nextBranchRoles as $roles) {
                        abort_unless(in_array('read', CenterPermissions::actions($roles), true), 422);
                    }
                    $beforeRevision = CenterPermissions::revision($currentCenterRoles, $previousBranchRoles);
                    $afterRevision = CenterPermissions::revision($centerRoles, $nextBranchRoles);
                    if ($beforeRevision === $afterRevision) {
                        return;
                    }
                    if (isset($data['grant_revision']) && $data['grant_revision'] !== $beforeRevision) {
                        throw new HttpResponseException(response()->json(['code' => 'grants_changed'], 409));
                    }
                    if (! $permissions->isOwner()) {
                        foreach (array_unique([...array_keys($previousBranchRoles), ...$branchIds]) as $branchId) {
                            $beforeApproval = in_array('financial_approval', $previousBranchRoles[$branchId] ?? [], true);
                            $afterApproval = in_array('financial_approval', $nextBranchRoles[$branchId] ?? [], true);
                            abort_if($beforeApproval !== $afterApproval, 403);
                        }
                    }

                    DB::connection('tenant')->table('center_grants')->where('user_id', $membership->user_id)->delete();
                    DB::connection('tenant')->table('branch_grants')->where('user_id', $membership->user_id)
                        ->when($scope !== null, fn ($query) => $query->whereIn('branch_id', $scope))->delete();
                    foreach ($centerRoles as $role) {
                        DB::connection('tenant')->table('center_grants')->insert([
                            'user_id' => $membership->user_id, 'role' => $role,
                            'created_at' => now(), 'updated_at' => now(),
                        ]);
                    }
                    foreach ($data['branch_roles'] as $branchId => $roles) {
                        foreach (array_unique($roles) as $role) {
                            DB::connection('tenant')->table('branch_grants')->insert([
                                'user_id' => $membership->user_id, 'branch_id' => (int) $branchId, 'role' => $role,
                                'created_at' => now(), 'updated_at' => now(),
                            ]);
                        }
                    }
                    $this->audit($request, 'member.grants_changed', [
                        'user_id' => $membership->user_id, 'center_roles' => $centerRoles, 'branch_roles' => $data['branch_roles'],
                        'center_roles_before' => $currentCenterRoles, 'center_roles_after' => $centerRoles,
                        'branch_roles_before' => $previousBranchRoles, 'branch_roles_after' => $nextBranchRoles,
                        'role_labels' => CenterPermissions::labels(),
                    ]);
                    foreach (array_unique([...array_keys($previousBranchRoles), ...$branchIds]) as $branchId) {
                        $before = $previousBranchRoles[$branchId] ?? [];
                        $after = array_values(array_unique($data['branch_roles'][(string) $branchId] ?? []));
                        sort($before);
                        sort($after);
                        if ($before !== $after) {
                            $this->audit($request, 'member.branch_grants_changed', [
                                'user_id' => $membership->user_id, 'roles_before' => $before, 'roles_after' => $after,
                                'role_labels' => CenterPermissions::labels(),
                            ], (int) $branchId);
                        }
                    }
                    $membership->increment('grants_version');
                });
                $tenantCommitted = true;
            });
        } catch (Throwable $exception) {
            if ($tenantCommitted) {
                // The tenant commit may have succeeded while the central commit failed.
                // Authorization reads tenant grants directly; retry version invalidation.
                report($exception);
                try {
                    DB::purge('central');
                    CenterMembership::query()->whereKey($membership->id)->increment('grants_version');
                    $membership->refresh();

                    return response()->json(['grants_version' => $membership->grants_version]);
                } catch (Throwable $recoveryFailure) {
                    $slug = $request->attributes->get('center')->slug;
                    report(new RuntimeException(
                        "Grant version recovery is pending for center {$slug}. After central recovery run: courses:reconcile-grants {$slug} --apply --invalidate-versions",
                        0,
                        $recoveryFailure,
                    ));
                }
            }
            throw $exception;
        }

        return response()->json(['grants_version' => $membership->grants_version]);
    }

    private function requireManager(Request $request): CenterPermissions
    {
        $permissions = $request->attributes->get('center_permissions');
        abort_unless($permissions->isCenterManager(), 403);

        return $permissions;
    }

    private function assertCurrentManager(Request $request): CenterPermissions
    {
        $center = $request->attributes->get('center');
        abort_unless(CenterMembership::query()->where('tenant_id', $center->id)
            ->where('user_id', $request->user()->id)->where('status', 'active')->exists(), 403);
        $permissions = CenterPermissions::forUser($request->user()->id);
        abort_unless($permissions->isCenterManager(), 403);

        return $permissions;
    }

    private function assertSameCenter(Request $request, CenterMembership $membership): void
    {
        abort_unless($membership->tenant_id === $request->attributes->get('center')->id, 404);
    }

    private function protectLastOwner(CenterMembership $membership): void
    {
        $isOwner = DB::connection('tenant')->table('center_grants')
            ->where('user_id', $membership->user_id)->where('role', 'center_owner')->exists();
        if (! $isOwner || $membership->status !== 'active') {
            return;
        }

        $ownerIds = DB::connection('tenant')->table('center_grants')
            ->where('role', 'center_owner')->pluck('user_id');
        $activeOwners = CenterMembership::query()->where('tenant_id', $membership->tenant_id)
            ->where('status', 'active')->whereIn('user_id', $ownerIds)->count();
        if ($activeOwners <= 1) {
            throw new HttpResponseException(response()->json(['code' => 'last_active_owner'], 409));
        }
    }

    private function lockCenter(CenterMembership $membership): void
    {
        DB::connection('central')->table('tenants')->where('id', $membership->tenant_id)
            ->lockForUpdate()->first(['id']);
    }

    private function audit(Request $request, string $event, array $details, ?int $branchId = null): void
    {
        DB::connection('tenant')->table('center_audit_logs')->insert([
            'actor_id' => $request->user()->id, 'branch_id' => $branchId, 'event' => $event,
            'details' => json_encode($details), 'created_at' => now(),
        ]);
    }
}
