<?php

namespace App\Http\Controllers;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Support\CenterPermissions;
use App\Support\StudentContacts;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use stdClass;

class CenterStudentSearchController extends Controller
{
    public function workspace(Request $request): JsonResponse
    {
        $data = $request->validate(['q' => ['nullable', 'string', 'max:255'], 'page' => ['sometimes', 'integer', 'min:1', 'max:100000'], 'view' => ['sometimes', 'in:settings']]);
        $permissions = $request->attributes->get('center_permissions');
        abort_unless(self::hasSearchPermission($permissions), 403);
        $policy = DB::connection('tenant')->table('student_search_policy')->where('id', 1)->first(['enabled', 'revision', 'default_sharing_enabled']);
        $showSettings = ($data['view'] ?? null) === 'settings' && $permissions->isCenterManager();
        $page = $showSettings ? 1 : (int) ($data['page'] ?? 1);
        $query = $showSettings ? '' : trim($data['q'] ?? '');
        $students = collect();
        if ($policy->enabled && $query !== '') {
            $search = self::normalizeName($query);
            $phone = self::normalizePhone($query);
            $scope = DB::connection('tenant')->table('student_branches')->whereColumn('student_id', 'students.id');
            if (! $permissions->isCenterManager()) {
                $scope->whereIn('branch_id', self::readableBranches($permissions));
            }
            $openScope = clone $scope;
            $permissions->workspace?->constrain($openScope, 'branch_id');
            $students = DB::connection('tenant')->table('students')->select(['students.id', 'student_number', 'name'])
                ->selectRaw(StudentContacts::phoneSql().' as phone')
                ->selectSub((clone $openScope)->selectRaw('count(*) > 0'), 'within_scope')
                ->where(function (Builder $rows) use ($scope): void {
                    $rows->where('students.sharing_enabled', true)->orWhereExists((clone $scope)->selectRaw('1'));
                })
                ->where(function (Builder $rows) use ($search, $phone, $query): void {
                    $rows->whereRaw('strpos(name_search, ?) > 0', [$search]);
                    if ($phone !== null) {
                        StudentContacts::matchPhone($rows, $phone);
                    }
                    if (ctype_digit($query) && strlen($query) <= 18) {
                        $rows->orWhere('student_number', $query);
                    }
                })->orderBy('student_number')->offset(($page - 1) * 50)->limit(51)->get();
        }

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(), 'branches' => [],
            'policy' => ['enabled' => (bool) $policy->enabled, 'revision' => $policy->revision, 'default_sharing_enabled' => (bool) $policy->default_sharing_enabled],
            'can_search' => (bool) $policy->enabled,
            'students' => $students->take(50)->map(fn (stdClass $row): array => [
                'id' => $row->id, 'student_number' => $row->student_number, 'name' => $row->name, 'phone' => $row->phone,
                'within_scope' => (bool) $row->within_scope,
            ])->values(),
            'pagination' => ['page' => $page, 'has_more' => $students->count() > 50],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function updatePolicy(Request $request): JsonResponse
    {
        $data = $request->validate(['enabled' => ['required_without:default_sharing_enabled', 'boolean'], 'default_sharing_enabled' => ['sometimes', 'boolean'], 'revision' => ['required', 'integer', 'min:1']]);

        return DB::connection('central')->transaction(function () use ($request, $data): JsonResponse {
            $centerId = $request->attributes->get('center')->id;
            $center = Center::query()->whereKey($centerId)->lockForUpdate()->firstOrFail();
            abort_if($center->suspended, 423);
            abort_unless($center->provisioning_status === 'active', 503);
            abort_unless(CenterMembership::query()->where('tenant_id', $centerId)->where('user_id', $request->user()->id)->value('status') === 'active', 403);

            return DB::connection('tenant')->transaction(function () use ($request, $data): JsonResponse {
                abort_unless(CenterPermissions::forUser($request->user()->id)->isCenterManager(), 403);
                $policy = DB::connection('tenant')->table('student_search_policy')->where('id', 1)->lockForUpdate()->first();
                $enabled = (bool) ($data['enabled'] ?? $policy->enabled);
                $defaultSharing = (bool) ($data['default_sharing_enabled'] ?? $policy->default_sharing_enabled);
                if ((bool) $policy->enabled !== $enabled || (bool) $policy->default_sharing_enabled !== $defaultSharing) {
                    if ($policy->revision !== (int) $data['revision']) {
                        throw new HttpResponseException(response()->json(['code' => 'student_search_policy_changed'], 409));
                    }
                    DB::connection('tenant')->table('student_search_policy')->where('id', 1)->update([
                        'enabled' => $enabled, 'default_sharing_enabled' => $defaultSharing, 'revision' => $policy->revision + 1, 'updated_at' => now(),
                    ]);
                    foreach (['enabled' => ['center.student_search_changed', $enabled], 'default_sharing_enabled' => ['center.student_sharing_default_changed', $defaultSharing]] as $field => [$event, $value]) {
                        if ((bool) $policy->{$field} !== $value) {
                            DB::connection('tenant')->table('center_audit_logs')->insert([
                                'actor_id' => $request->user()->id, 'event' => $event,
                                'details' => json_encode(['before' => [$field => (bool) $policy->{$field}], 'after' => [$field => $value]]), 'created_at' => now(),
                            ]);
                        }
                    }
                    $policy->enabled = $enabled;
                    $policy->default_sharing_enabled = $defaultSharing;
                    $policy->revision++;
                }

                return response()->json(['policy' => ['enabled' => (bool) $policy->enabled, 'revision' => $policy->revision, 'default_sharing_enabled' => (bool) $policy->default_sharing_enabled]])->header('Cache-Control', 'private, no-store');
            });
        });
    }

    public static function hasSearchPermission(CenterPermissions $permissions): bool
    {
        return $permissions->isCenterManager() || collect($permissions->branchRoles)
            ->contains(fn (array $roles): bool => in_array('students.search_center', CenterPermissions::actions($roles), true));
    }

    public static function readableBranches(CenterPermissions $permissions): array
    {
        return array_keys(array_filter($permissions->branchRoles, fn (array $roles): bool => in_array('read', CenterPermissions::actions($roles), true)));
    }

    public static function normalizeName(string $name): string
    {
        return mb_strtolower(preg_replace('/\s+/u', ' ', trim($name)));
    }

    public static function normalizePhone(?string $phone): ?string
    {
        $value = preg_replace('/[^0-9]/', '', strtr($phone ?? '', array_combine(mb_str_split('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'), str_split('01234567890123456789'))));

        return $value === '' ? null : $value;
    }
}
