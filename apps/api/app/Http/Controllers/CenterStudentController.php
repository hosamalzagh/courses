<?php

namespace App\Http\Controllers;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Support\CenterPermissions;
use Closure;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use stdClass;

class CenterStudentController extends Controller
{
    public function workspace(Request $request, ?string $studentId = null): JsonResponse
    {
        $data = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'branches_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'q' => ['nullable', 'string', 'max:255'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        $page = (int) ($data['page'] ?? 1);
        $branchPage = (int) ($data['branches_page'] ?? 1);
        $branches = DB::connection('tenant')->table('branches')->orderBy('id');
        if (! $permissions->isCenterManager()) {
            $branches->whereIn('id', $this->branchScope($permissions, 'read'));
        }
        $branches = $branches->offset(($branchPage - 1) * 50)->limit(51)->get(['id', 'name', 'slug', 'address']);
        $query = $this->visibleStudents($permissions);
        if ($studentId !== null) {
            abort_unless(Str::isUuid($studentId), 404);
            $query->where('students.id', $studentId);
        }
        if (isset($data['q']) && trim($data['q']) !== '') {
            $search = $this->normalizeName($data['q']);
            $phone = $this->normalizePhone($data['q']);
            $query->where(function (Builder $query) use ($search, $phone, $data): void {
                $query->whereRaw('strpos(name_search, ?) > 0', [$search]);
                if ($phone !== null) {
                    $query->orWhereRaw('strpos(phone_search, ?) > 0', [$phone]);
                }
                if (ctype_digit($data['q']) && strlen($data['q']) <= 18) {
                    $query->orWhere('student_number', $data['q']);
                }
            });
        }
        $students = $query->orderBy('student_number')->offset(($page - 1) * 50)->limit(51)->get();
        if ($studentId !== null) {
            abort_if($students->isEmpty(), 404);
        }

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(),
            'branches' => $branches->take(50)->values(),
            'students' => $students->take(50)->map(fn (stdClass $student): array => $this->payload($student, $permissions))->values(),
            'pagination' => ['page' => $page, 'has_more' => $students->count() > 50, 'branches_page' => $branchPage, 'branches_has_more' => $branches->count() > 50],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function similar(Request $request): JsonResponse
    {
        $data = $request->validate(['name' => ['nullable', 'string', 'max:255'], 'phone' => ['nullable', 'string', 'max:50'], 'exclude' => ['nullable', 'uuid']]);
        $permissions = $request->attributes->get('center_permissions');
        $query = $this->visibleStudents($permissions);
        $name = $this->normalizeName($data['name'] ?? '');
        $phone = $this->normalizePhone($data['phone'] ?? null);
        if ($name === '' && $phone === null) {
            return response()->json(['students' => []])->header('Cache-Control', 'private, no-store');
        }
        $query->where(function (Builder $query) use ($name, $phone): void {
            if ($name !== '') {
                $query->where('name_search', $name);
            }
            if ($phone !== null) {
                $query->orWhere('phone_search', $phone);
            }
        })->when(! empty($data['exclude']), fn (Builder $query) => $query->where('students.id', '!=', $data['exclude']));

        return response()->json(['students' => $query->orderBy('student_number')->limit(10)->get()
            ->map(fn (stdClass $student): array => $this->payload($student, $permissions))])
            ->header('Cache-Control', 'private, no-store');
    }

    public function submission(Request $request, string $requestId): JsonResponse
    {
        abort_unless(Str::isUuid($requestId), 404);
        $permissions = $request->attributes->get('center_permissions');
        $student = $this->visibleStudents($permissions)->where('request_id', $requestId)
            ->where('created_by', $request->user()->id)->first();
        abort_unless($student, 404);

        return response()->json(['student' => $this->payload($student, $permissions)])
            ->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request): JsonResponse
    {
        $data = $this->validateProfile($request);
        $request->validate(['request_id' => ['required', 'uuid']]);

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $data): JsonResponse {
            $this->authorizeBranches($permissions, $data['branch_ids']);
            $hash = hash('sha256', json_encode($data));
            $existing = DB::connection('tenant')->table('students')->where('request_id', $request->input('request_id'))->first();
            if ($existing) {
                abort_unless($existing->created_by === $request->user()->id, 403);
                if ($existing->request_hash !== $hash) {
                    $this->conflict('student_request_changed');
                }

                return response()->json(['student' => $this->read($existing->id, $permissions)]);
            }
            $id = (string) Str::uuid();
            DB::connection('tenant')->table('students')->insert([
                'id' => $id, 'name' => $data['name'], 'phone' => $data['phone'],
                'name_search' => $this->normalizeName($data['name']), 'phone_search' => $this->normalizePhone($data['phone']),
                'request_id' => $request->input('request_id'), 'request_hash' => $hash, 'created_by' => $request->user()->id,
                'created_at' => now(), 'updated_at' => now(),
            ]);
            $this->associate($id, $data['branch_ids']);
            $student = $this->read($id, $permissions);
            $this->audit($request, 'student.created', $student, null, $data['branch_ids']);

            return response()->json(['student' => $student], 201);
        });
    }

    public function update(Request $request, string $studentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId), 404);
        $data = $this->validateProfile($request);
        $request->validate(['revision' => ['required', 'integer', 'min:1']]);

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $data, $studentId): JsonResponse {
            $row = DB::connection('tenant')->table('students')->where('id', $studentId)->lockForUpdate()->first();
            abort_unless($row, 404);
            $before = $this->read($studentId, $permissions);
            abort_unless($before['can_manage'], 403);
            $this->authorizeBranches($permissions, $data['branch_ids']);
            $currentBranches = DB::connection('tenant')->table('student_branches')->where('student_id', $studentId)->pluck('branch_id')->all();
            $added = array_diff($data['branch_ids'], $currentBranches);
            if ($row->name === $data['name'] && $row->phone === $data['phone'] && $added === []) {
                return response()->json(['student' => $before]);
            }
            if ($row->revision !== (int) $request->input('revision')) {
                $this->conflict('student_changed');
            }
            DB::connection('tenant')->table('students')->where('id', $studentId)->update([
                'name' => $data['name'], 'phone' => $data['phone'],
                'name_search' => $this->normalizeName($data['name']), 'phone_search' => $this->normalizePhone($data['phone']),
                'revision' => $row->revision + 1, 'updated_at' => now(),
            ]);
            $this->associate($studentId, $added);
            $student = $this->read($studentId, $permissions);
            $this->audit($request, 'student.updated', $student, $before, array_unique([...$currentBranches, ...$added]), $currentBranches);

            return response()->json(['student' => $student]);
        });
    }

    private function write(Request $request, Closure $operation): JsonResponse
    {
        return DB::connection('central')->transaction(function () use ($request, $operation): JsonResponse {
            $centerId = $request->attributes->get('center')->id;
            $center = Center::query()->whereKey($centerId)->lockForUpdate()->firstOrFail();
            abort_if($center->suspended, 423);
            abort_unless($center->provisioning_status === 'active', 503);
            abort_unless(CenterMembership::query()->where('tenant_id', $centerId)->where('user_id', $request->user()->id)->value('status') === 'active', 403);

            return DB::connection('tenant')->transaction(fn (): JsonResponse => $operation(CenterPermissions::forUser($request->user()->id)));
        });
    }

    private function validateProfile(Request $request): array
    {
        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'], 'phone' => ['nullable', 'string', 'max:50'],
            'branch_ids' => ['present', 'array', $request->isMethod('POST') ? 'min:1' : 'min:0', 'max:50'], 'branch_ids.*' => ['integer', 'distinct'],
            'student_number' => ['prohibited'], 'user_id' => ['prohibited'],
        ], ['name.required' => 'أدخل اسم الطالب.', 'branch_ids.required' => 'اختر فرعًا مصرحًا به على الأقل.']);
        $data['name'] = trim($data['name']);
        abort_if($data['name'] === '', 422, 'أدخل اسم الطالب.');
        $data['phone'] = isset($data['phone']) ? trim($data['phone']) : null;
        $data['branch_ids'] = array_map('intval', $data['branch_ids']);
        sort($data['branch_ids']);

        return $data;
    }

    private function authorizeBranches(CenterPermissions $permissions, array $branchIds): void
    {
        foreach ($branchIds as $branchId) {
            abort_unless($permissions->can('students.manage', $branchId), 403);
        }
        abort_unless(DB::connection('tenant')->table('branches')->whereIn('id', $branchIds)->count() === count($branchIds), 403);
    }

    private function branchScope(CenterPermissions $permissions, string $action): array
    {
        return array_keys(array_filter($permissions->branchRoles, fn (array $roles): bool => in_array($action, CenterPermissions::actions($roles), true)));
    }

    private function visibleStudents(CenterPermissions $permissions): Builder
    {
        $associations = DB::connection('tenant')->table('student_branches')->whereColumn('student_id', 'students.id');
        if (! $permissions->isCenterManager()) {
            $associations->whereIn('branch_id', $this->branchScope($permissions, 'read'));
        }

        return DB::connection('tenant')->table('students')
            ->select(['students.id', 'student_number', 'name', 'phone', 'revision'])
            ->selectSub((clone $associations)->selectRaw('json_agg(branch_id ORDER BY branch_id)'), 'branch_ids')
            ->whereExists((clone $associations)->selectRaw('1'));
    }

    private function payload(stdClass $row, CenterPermissions $permissions): array
    {
        $branches = json_decode($row->branch_ids, true);

        return ['id' => $row->id, 'student_number' => $row->student_number, 'name' => $row->name, 'phone' => $row->phone,
            'revision' => $row->revision, 'branch_ids' => $branches,
            'can_manage' => collect($branches)->contains(fn (int $id): bool => $permissions->can('students.manage', $id))];
    }

    private function read(string $id, CenterPermissions $permissions): array
    {
        $row = $this->visibleStudents($permissions)->where('students.id', $id)->first();
        abort_unless($row, 404);

        return $this->payload($row, $permissions);
    }

    private function associate(string $id, array $branchIds): void
    {
        foreach ($branchIds as $branchId) {
            DB::connection('tenant')->table('student_branches')->insertOrIgnore(['student_id' => $id, 'branch_id' => $branchId, 'created_at' => now()]);
        }
    }

    private function audit(Request $request, string $event, array $after, ?array $before, array $branchIds, array $previousBranchIds = []): void
    {
        $basic = fn (?array $student): ?array => $student === null ? null : array_intersect_key($student, array_flip(['student_number', 'name', 'phone']));
        foreach ($branchIds as $branchId) {
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'branch_id' => $branchId, 'event' => $event,
                'details' => json_encode(['student_id' => $after['id'], 'before' => $basic($before), 'after' => $basic($after),
                    'associated_before' => in_array($branchId, $previousBranchIds, true), 'associated_after' => true]), 'created_at' => now(),
            ]);
        }
    }

    private function normalizeName(string $name): string
    {
        return mb_strtolower(preg_replace('/\s+/u', ' ', trim($name)));
    }

    private function normalizePhone(?string $phone): ?string
    {
        $value = preg_replace('/[^0-9]/', '', strtr($phone ?? '', array_combine(mb_str_split('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'), str_split('01234567890123456789'))));

        return $value === '' ? null : $value;
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
