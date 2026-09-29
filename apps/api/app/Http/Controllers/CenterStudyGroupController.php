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

class CenterStudyGroupController extends Controller
{
    public function instructorOptions(Request $request): JsonResponse
    {
        $data = $request->validate([
            'branch_id' => ['required', 'integer', 'min:1'],
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'q' => ['sometimes', 'string', 'max:80'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        abort_unless($this->canRead($permissions, (int) $data['branch_id'])
            && DB::connection('tenant')->table('branches')->where('id', $data['branch_id'])->exists(), 404);
        $page = (int) ($data['page'] ?? 1);
        $query = DB::connection('tenant')->table('instructor_branches')
            ->join('instructors', 'instructors.id', '=', 'instructor_branches.instructor_id')
            ->where('instructor_branches.branch_id', $data['branch_id']);
        if (isset($data['q']) && trim($data['q']) !== '') {
            $search = mb_strtolower(preg_replace('/\s+/u', ' ', trim($data['q'])));
            $query->whereRaw('strpos(instructors.name_search, ?) > 0', [$search]);
        }
        $rows = $query->orderBy('instructors.name_search')->orderBy('instructors.id')
            ->offset(($page - 1) * 50)->limit(51)->get(['instructors.id', 'instructors.name']);

        return response()->json([
            'instructors' => $rows->take(50)->values(),
            'pagination' => ['page' => $page, 'has_more' => $rows->count() > 50],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function workspace(Request $request, ?string $groupId = null): JsonResponse
    {
        $data = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'levels_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        if ($groupId !== null) {
            abort_unless(Str::isUuid($groupId), 404);
            $group = $this->find($groupId, $permissions, true);
            $groups = collect([$group]);
            $hasMore = false;
        } else {
            $page = (int) ($data['page'] ?? 1);
            $rows = $this->records($permissions)->orderBy('study_groups.created_at')->orderBy('study_groups.id')
                ->offset(($page - 1) * 50)->limit(51)->get();
            $hasMore = $rows->count() > 50;
            $groups = $rows->take(50)->map(fn ($row) => $this->present($row, $permissions));
        }
        $scope = $this->scope($permissions);
        $levelsPage = (int) ($data['levels_page'] ?? 1);
        $levels = DB::connection('tenant')->table('study_plan_versions as plans')
            ->join('levels', 'levels.id', '=', 'plans.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->join('branches', 'branches.id', '=', 'courses.branch_id')
            ->when(! $permissions->isCenterManager(), fn (Builder $query) => $query->whereIn('courses.branch_id', $scope))
            ->orderBy('courses.created_at')->orderBy('levels.id')->orderBy('plans.version')
            ->offset(($levelsPage - 1) * 50)->limit(51)
            ->select(['plans.id as plan_version_id', 'plans.version as plan_version', 'plans.level_id', 'levels.name as level_name',
                'courses.branch_id', 'branches.name as branch_name', 'courses.name as course_name', 'stages.name as stage_name'])
            ->selectRaw('COALESCE(levels.completion_threshold, stages.completion_threshold, courses.completion_threshold) AS completion_threshold')
            ->get();

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(),
            'groups' => $groups->values(),
            'level_choices' => $levels->take(50)->values(),
            'pagination' => [
                'groups' => ['page' => (int) ($data['page'] ?? 1), 'has_more' => $hasMore],
                'levels' => ['page' => $levelsPage, 'has_more' => $levels->count() > 50],
            ],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'level_id' => ['required', 'uuid'],
            'plan_version_id' => ['required', 'uuid'],
            'name' => ['required', 'string', 'max:255'],
            'approved_price' => ['required', 'numeric', 'decimal:0,2', 'min:0', 'max:9999999999.99'],
            'completion_threshold' => ['nullable', 'integer', 'between:1,100'],
            'instructor_ids' => ['required', 'array', 'min:1', 'max:50'],
            'instructor_ids.*' => ['required', 'uuid', 'distinct'],
            'request_id' => ['required', 'uuid'],
        ]);
        $data['name'] = trim($data['name']);
        abort_if($data['name'] === '', 422, 'أدخل اسم المجموعة.');
        $data['approved_price'] = $this->price($data['approved_price']);
        $data['instructor_ids'] = array_values($data['instructor_ids']);
        sort($data['instructor_ids']);
        $data['completion_threshold'] = $data['completion_threshold'] ?? null;

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $data): JsonResponse {
            $level = DB::connection('tenant')->table('levels')->join('stages', 'stages.id', '=', 'levels.stage_id')
                ->join('courses', 'courses.id', '=', 'stages.course_id')
                ->where('levels.id', $data['level_id'])->first(['courses.branch_id']);
            abort_unless($level && $this->canRead($permissions, (int) $level->branch_id), 404);
            abort_unless($permissions->can('curriculum.manage', (int) $level->branch_id), 403);
            abort_unless(DB::connection('tenant')->table('study_plan_versions')->where('id', $data['plan_version_id'])->where('level_id', $data['level_id'])->exists(), 422);
            $this->validateInstructors((int) $level->branch_id, $data['instructor_ids']);

            $hash = hash('sha256', json_encode($data));
            $existing = DB::connection('tenant')->table('study_groups')->where('request_id', $data['request_id'])->first();
            if ($existing) {
                abort_unless($existing->created_by === $request->user()->id, 403);
                if ($existing->request_hash !== $hash) {
                    $this->conflict('group_request_changed');
                }

                return response()->json(['group' => $this->find($existing->id, $permissions)]);
            }
            $id = (string) Str::uuid();
            DB::connection('tenant')->table('study_groups')->insert([
                'id' => $id, 'level_id' => $data['level_id'], 'plan_version_id' => $data['plan_version_id'],
                'name' => $data['name'], 'approved_price' => $data['approved_price'],
                'completion_threshold' => $data['completion_threshold'], 'status' => 'waiting', 'revision' => 1,
                'created_by' => $request->user()->id, 'request_id' => $data['request_id'], 'request_hash' => $hash,
                'created_at' => now(), 'updated_at' => now(),
            ]);
            DB::connection('tenant')->insert(<<<'SQL'
INSERT INTO study_group_requirements
    (id, group_id, plan_lecture_id, number, content, title, planned_hours, created_at)
SELECT gen_random_uuid(), ?, lectures.id, lectures.number, lectures.content,
    lectures.title, lectures.planned_hours, ?
FROM plan_lectures AS lectures WHERE lectures.plan_version_id = ?
SQL, [$id, now(), $data['plan_version_id']]);
            DB::connection('tenant')->table('study_group_instructors')->insert(array_map(
                fn (string $instructorId): array => ['group_id' => $id, 'instructor_id' => $instructorId], $data['instructor_ids']
            ));
            DB::connection('tenant')->table('study_plan_versions')->where('id', $data['plan_version_id'])->whereNull('used_at')->update(['used_at' => now()]);
            $group = $this->find($id, $permissions);
            $this->audit($request, 'study_group.created', (int) $level->branch_id, $id, null, $group);

            return response()->json(['group' => $group], 201);
        });
    }

    public function start(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $revision = (int) $request->validate(['revision' => ['required', 'integer', 'min:1']])['revision'];

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $groupId, $revision): JsonResponse {
            $before = $this->find($groupId, $permissions);
            abort_unless($permissions->can('curriculum.manage', $before['branch_id']), 403);
            $row = DB::connection('tenant')->table('study_groups')->where('id', $groupId)->lockForUpdate()->first();
            if ($row->status === 'started') {
                return response()->json(['group' => $before]);
            }
            if ($row->status !== 'waiting' || $row->revision !== $revision) {
                $this->conflict('group_changed');
            }
            DB::connection('tenant')->table('study_groups')->where('id', $groupId)->update([
                'status' => 'started', 'revision' => $revision + 1, 'started_at' => now(), 'updated_at' => now(),
            ]);
            $after = $this->find($groupId, $permissions);
            $this->audit($request, 'study_group.started', $before['branch_id'], $groupId, $before, $after);

            return response()->json(['group' => $after]);
        });
    }

    public function updateSettings(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $data = $request->validate([
            'revision' => ['required', 'integer', 'min:1'],
            'approved_price' => ['required', 'numeric', 'decimal:0,2', 'min:0', 'max:9999999999.99'],
            'completion_threshold' => ['present', 'nullable', 'integer', 'between:1,100'],
            'instructor_ids' => ['required', 'array', 'min:1', 'max:50'],
            'instructor_ids.*' => ['required', 'uuid', 'distinct'],
        ]);
        $data['approved_price'] = $this->price($data['approved_price']);
        $data['instructor_ids'] = array_values($data['instructor_ids']);
        sort($data['instructor_ids']);

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $groupId, $data): JsonResponse {
            $before = $this->find($groupId, $permissions);
            abort_unless($permissions->can('curriculum.manage', $before['branch_id']), 403);
            $row = DB::connection('tenant')->table('study_groups')->where('id', $groupId)->lockForUpdate()->first();
            if ($row->revision !== (int) $data['revision'] || $row->status === 'completed') {
                $this->conflict('group_changed');
            }
            $this->validateInstructors($before['branch_id'], $data['instructor_ids']);
            $beforeIds = array_column($before['instructors'], 'id');
            sort($beforeIds);
            if ($row->approved_price === $data['approved_price']
                && $row->completion_threshold === $data['completion_threshold'] && $beforeIds === $data['instructor_ids']) {
                return response()->json(['group' => $before]);
            }
            DB::connection('tenant')->table('study_groups')->where('id', $groupId)->update([
                'approved_price' => $data['approved_price'], 'completion_threshold' => $data['completion_threshold'],
                'revision' => $row->revision + 1, 'updated_at' => now(),
            ]);
            DB::connection('tenant')->table('study_group_instructors')->where('group_id', $groupId)->delete();
            DB::connection('tenant')->table('study_group_instructors')->insert(array_map(
                fn (string $instructorId): array => ['group_id' => $groupId, 'instructor_id' => $instructorId], $data['instructor_ids']
            ));
            $after = $this->find($groupId, $permissions);
            $this->audit($request, 'study_group.settings_updated', $before['branch_id'], $groupId, $before, $after);

            return response()->json(['group' => $after]);
        });
    }

    private function validateInstructors(int $branchId, array $ids): void
    {
        $linked = DB::connection('tenant')->table('instructor_branches')->where('branch_id', $branchId)
            ->whereIn('instructor_id', $ids)->count();
        abort_unless($linked === count($ids), 422, 'اختر محاضرين مرتبطين بهذا الفرع.');
    }

    private function price(string|int|float $value): string
    {
        $text = (string) $value;
        abort_unless(preg_match('/^\d{1,10}(?:\.\d{1,2})?$/', $text) === 1, 422, 'أدخل سعرًا صحيحًا حتى منزلتين عشريتين.');
        [$whole, $fraction] = array_pad(explode('.', $text, 2), 2, '');

        return (string) ((int) $whole).'.'.str_pad($fraction, 2, '0');
    }

    private function records(CenterPermissions $permissions, bool $includeLectures = false): Builder
    {
        $query = DB::connection('tenant')->table('study_groups')
            ->join('levels', 'levels.id', '=', 'study_groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->join('branches', 'branches.id', '=', 'courses.branch_id')
            ->join('study_plan_versions as plans', 'plans.id', '=', 'study_groups.plan_version_id')
            ->select([
                'study_groups.id', 'study_groups.level_id', 'study_groups.plan_version_id', 'study_groups.name',
                'study_groups.status', 'study_groups.approved_price', 'study_groups.revision', 'study_groups.started_at',
                'study_groups.completion_threshold as completion_threshold_override',
                'courses.branch_id', 'branches.name as branch_name', 'courses.name as course_name', 'stages.name as stage_name', 'levels.name as level_name',
                'plans.version as plan_version',
            ])->selectRaw(<<<'SQL'
COALESCE(study_groups.completion_threshold, levels.completion_threshold, stages.completion_threshold, courses.completion_threshold) AS completion_threshold,
(SELECT count(*) FROM study_group_requirements WHERE group_id = study_groups.id AND retired_at IS NULL) AS approved_lecture_count,
COALESCE((SELECT json_agg(json_build_object('id', instructors.id, 'name', instructors.name) ORDER BY instructors.name)
FROM study_group_instructors JOIN instructors ON instructors.id = study_group_instructors.instructor_id
WHERE study_group_instructors.group_id = study_groups.id), '[]'::json) AS instructors
SQL);
        if ($includeLectures) {
            $query->selectRaw(<<<'SQL'
COALESCE((SELECT json_agg(json_build_object('number', lecture.number, 'content', lecture.content, 'title', lecture.title, 'planned_hours', lecture.planned_hours::float) ORDER BY lecture.number)
FROM (SELECT number, content, title, planned_hours FROM study_group_requirements WHERE group_id = study_groups.id AND retired_at IS NULL ORDER BY number LIMIT 200) lecture), '[]'::json) AS approved_lectures
SQL);
        }
        if (! $permissions->isCenterManager()) {
            $query->whereIn('courses.branch_id', $this->scope($permissions));
        }

        return $query;
    }

    private function scope(CenterPermissions $permissions): array
    {
        return array_keys(array_filter($permissions->branchRoles,
            fn (array $roles): bool => in_array('read', CenterPermissions::actions($roles), true)));
    }

    private function find(string $id, CenterPermissions $permissions, bool $includeLectures = false): array
    {
        $row = $this->records($permissions, $includeLectures)->where('study_groups.id', $id)->first();
        abort_unless($row, 404);

        return $this->present($row, $permissions);
    }

    private function present(object $row, CenterPermissions $permissions): array
    {
        return [...(array) $row, 'instructors' => json_decode($row->instructors, true),
            ...isset($row->approved_lectures) ? ['approved_lectures' => json_decode($row->approved_lectures, true)] : [],
            'can_manage' => $permissions->can('curriculum.manage', (int) $row->branch_id)];
    }

    private function canRead(CenterPermissions $permissions, int $branchId): bool
    {
        return $permissions->can('read', $branchId);
    }

    private function write(Request $request, Closure $operation): JsonResponse
    {
        return DB::connection('central')->transaction(function () use ($request, $operation): JsonResponse {
            $center = Center::query()->whereKey($request->attributes->get('center')->id)->lockForUpdate()->firstOrFail();
            abort_if($center->suspended, 423);
            abort_unless($center->provisioning_status === 'active', 503);
            abort_unless(CenterMembership::query()->where('tenant_id', $center->id)->where('user_id', $request->user()->id)->value('status') === 'active', 403);

            return DB::connection('tenant')->transaction(fn (): JsonResponse => $operation(CenterPermissions::forUser($request->user()->id)));
        });
    }

    private function audit(Request $request, string $event, int $branchId, string $groupId, ?array $before, array $after): void
    {
        DB::connection('tenant')->table('center_audit_logs')->insert([
            'actor_id' => $request->user()->id, 'branch_id' => $branchId, 'event' => $event,
            'details' => json_encode(['kind' => 'study_groups', 'record_id' => $groupId, 'before' => $before, 'after' => $after]),
            'created_at' => now(),
        ]);
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
