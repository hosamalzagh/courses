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

class CenterCurriculumController extends Controller
{
    public function workspace(Request $request, ?string $levelId = null): JsonResponse
    {
        $data = $request->validate([
            'courses_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'stages_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'levels_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'branches_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'plan_version' => ['sometimes', 'integer', 'min:1'],
            'versions_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
        ]);
        if ($levelId !== null) {
            abort_unless(Str::isUuid($levelId), 404);
        }
        $permissions = $request->attributes->get('center_permissions');
        $pagination = [];
        foreach (['courses', 'stages', 'levels', 'branches'] as $kind) {
            $pagination[$kind] = ['page' => (int) ($data[$kind.'_page'] ?? 1), 'has_more' => false];
        }
        $branches = DB::connection('tenant')->table('branches')->orderBy('id');
        if (! $permissions->isCenterManager()) {
            $branches->whereIn('id', $this->scope($permissions));
        }
        $branches = $branches->offset(($pagination['branches']['page'] - 1) * 50)->limit(51)->get(['id', 'name', 'slug', 'address']);
        $pagination['branches']['has_more'] = $branches->count() > 50;
        $queries = [];
        foreach (['courses', 'stages', 'levels'] as $kind) {
            $query = $this->records($kind, $permissions, $levelId !== null,
                $levelId !== null ? ($data['plan_version'] ?? null) : null,
                $levelId !== null ? (int) ($data['versions_page'] ?? 1) : 1, $levelId !== null);
            if ($kind === 'levels' && $levelId !== null) {
                $query->where('levels.id', $levelId);
            }
            $query->orderBy($kind.'.created_at')->orderBy($kind.'.id')->offset(($pagination[$kind]['page'] - 1) * 50)->limit(51);
            $queries[] = DB::connection('tenant')->query()->fromSub($query, 'bounded_records')->selectRaw('?::text AS kind, to_jsonb(bounded_records) AS payload', [$kind]);
        }
        $union = array_shift($queries);
        foreach ($queries as $query) {
            $union->unionAll($query);
        }
        $rows = $union->get()->groupBy('kind');
        $records = [];
        foreach (['courses', 'stages', 'levels'] as $kind) {
            $items = $rows->get($kind, collect());
            $pagination[$kind]['has_more'] = $items->count() > 50;
            $records[$kind] = $items->take(50)->map(function ($row) use ($permissions, $levelId, $data): array {
                $record = json_decode($row->payload, true);
                $record['can_manage'] = $permissions->can('curriculum.manage', $record['branch_id']);
                if ($levelId !== null && isset($record['plan_history'])) {
                    $history = $record['plan_history'];
                    $record['plan_history'] = array_slice($history, 0, 20);
                    $record['plan_history_pagination'] = ['page' => (int) ($data['versions_page'] ?? 1),
                        'has_more' => count($history) > 20];
                }

                return $record;
            })->values();
        }
        if ($levelId !== null) {
            abort_if($records['levels']->isEmpty(), 404);
        }

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(), 'branches' => $branches->take(50)->values(),
            ...$records, 'pagination' => $pagination,
        ])->header('Cache-Control', 'private, no-store');
    }

    public function storeCourse(Request $request): JsonResponse
    {
        $data = $this->validateName($request);
        $data['branch_id'] = (int) $request->validate(['branch_id' => ['required', 'integer', 'min:1']])['branch_id'];

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $data): JsonResponse {
            $this->authorize($permissions, $data['branch_id']);
            abort_unless(DB::connection('tenant')->table('branches')->where('id', $data['branch_id'])->exists(), 404);

            return $this->create($request, 'courses', $data, $data['branch_id'], $permissions);
        });
    }

    public function storeStage(Request $request, string $courseId): JsonResponse
    {
        abort_unless(Str::isUuid($courseId), 404);
        $data = [...$this->validateName($request), 'course_id' => $courseId];

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $data, $courseId): JsonResponse {
            $course = $this->read('courses', $courseId, $permissions);
            $this->authorize($permissions, $course['branch_id']);

            return $this->create($request, 'stages', $data, $course['branch_id'], $permissions);
        });
    }

    public function storeLevel(Request $request, string $stageId): JsonResponse
    {
        abort_unless(Str::isUuid($stageId), 404);
        $data = [...$this->validateName($request), 'stage_id' => $stageId, 'lectures' => $this->validateLectures($request)];

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $data, $stageId): JsonResponse {
            $stage = $this->read('stages', $stageId, $permissions);
            $this->authorize($permissions, $stage['branch_id']);

            return $this->create($request, 'levels', $data, $stage['branch_id'], $permissions);
        });
    }

    public function submission(Request $request, string $requestId): JsonResponse
    {
        abort_unless(Str::isUuid($requestId), 404);
        $permissions = $request->attributes->get('center_permissions');
        $submission = DB::connection('tenant')->table('curriculum_submissions')->where('request_id', $requestId)->where('created_by', $request->user()->id)->first();
        abort_unless($submission, 404);
        if ($submission->kind === 'plan_versions') {
            $plan = DB::connection('tenant')->table('study_plan_versions')->where('id', $submission->record_id)->first(['level_id', 'version']);
            abort_unless($plan, 404);
            $record = $this->read('levels', $plan->level_id, $permissions, (int) $plan->version);

            return response()->json(['kind' => $submission->kind, 'record' => $record])->header('Cache-Control', 'private, no-store');
        }
        $record = $this->read($submission->kind, $submission->record_id, $permissions);

        return response()->json(['kind' => $submission->kind, 'record' => $record])->header('Cache-Control', 'private, no-store');
    }

    public function updatePlan(Request $request, string $levelId): JsonResponse
    {
        abort_unless(Str::isUuid($levelId), 404);
        $data = $request->validate(['revision' => ['required', 'integer', 'min:1'], 'plan_version_id' => ['required', 'uuid']]);
        $lectures = $this->validateLectures($request);

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $data, $lectures, $levelId): JsonResponse {
            $level = $this->read('levels', $levelId, $permissions, 1);
            $this->authorize($permissions, $level['branch_id']);
            $plan = DB::connection('tenant')->table('study_plan_versions')->where('level_id', $levelId)->where('version', 1)->lockForUpdate()->first();
            if ($plan->id !== $data['plan_version_id']) {
                $this->conflict('curriculum_changed');
            }
            $before = $this->read('levels', $levelId, $permissions, 1);
            $current = array_map(fn (array $lecture): array => [...array_diff_key($lecture, ['id' => true]), 'planned_hours' => (float) $lecture['planned_hours']], $before['plan']['lectures']);
            if ($current === $lectures) {
                return response()->json(['level' => $before]);
            }
            if ($plan->used_at !== null || (int) $before['latest_version'] > 1) {
                $this->conflict('plan_used');
            }
            if ($plan->revision !== (int) $data['revision']) {
                $this->conflict('curriculum_changed');
            }
            DB::connection('tenant')->table('plan_lectures')->where('plan_version_id', $plan->id)->delete();
            $this->insertLectures($plan->id, $lectures);
            DB::connection('tenant')->table('study_plan_versions')->where('id', $plan->id)->update(['revision' => $plan->revision + 1, 'updated_at' => now()]);
            $after = $this->read('levels', $levelId, $permissions, 1);
            $this->audit($request, 'curriculum.plan_updated', $level['branch_id'], 'levels', $before, $after);

            return response()->json(['level' => $after]);
        });
    }

    public function storePlanVersion(Request $request, string $levelId): JsonResponse
    {
        abort_unless(Str::isUuid($levelId), 404);
        $data = $request->validate([
            'base_plan_version_id' => ['required', 'uuid'],
            'base_revision' => ['required', 'integer', 'min:1'],
            'request_id' => ['required', 'uuid'],
        ]);
        $lectures = $this->validateLectures($request);
        $hash = hash('sha256', json_encode([$levelId, $data['base_plan_version_id'],
            (int) $data['base_revision'], $lectures]));

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $levelId, $data, $lectures, $hash): JsonResponse {
            $level = $this->read('levels', $levelId, $permissions);
            $this->authorize($permissions, $level['branch_id']);
            DB::connection('tenant')->table('levels')->where('id', $levelId)->lockForUpdate()->first();
            $submission = DB::connection('tenant')->table('curriculum_submissions')->where('request_id', $data['request_id'])->first();
            if ($submission !== null) {
                abort_unless($submission->created_by === $request->user()->id && $submission->kind === 'plan_versions'
                    && (int) $submission->branch_id === (int) $level['branch_id'], 403);
                if ($submission->request_hash !== $hash) {
                    $this->conflict('curriculum_request_changed');
                }
                $saved = DB::connection('tenant')->table('study_plan_versions')->where('id', $submission->record_id)
                    ->where('level_id', $levelId)->first(['version']);
                abort_unless($saved, 404);

                return response()->json(['plan' => $this->read('levels', $levelId, $permissions, (int) $saved->version)['plan']]);
            }
            $base = DB::connection('tenant')->table('study_plan_versions')->where('level_id', $levelId)
                ->orderByDesc('version')->lockForUpdate()->first();
            if ($base->id !== $data['base_plan_version_id'] || (int) $base->revision !== (int) $data['base_revision']) {
                $this->conflict('curriculum_changed');
            }
            $current = array_map(fn (array $lecture): array => [...array_diff_key($lecture, ['id' => true]),
                'planned_hours' => (float) $lecture['planned_hours']], $level['plan']['lectures']);
            abort_if($current === $lectures, 422, 'غيّر محتوى محاضرة أو عنوانها أو ساعاتها قبل إنشاء إصدار جديد.');
            $planId = (string) Str::uuid();
            DB::connection('tenant')->table('study_plan_versions')->insert([
                'id' => $planId, 'level_id' => $levelId, 'version' => $base->version + 1, 'revision' => 1,
                'created_at' => now(), 'updated_at' => now(),
            ]);
            $this->insertLectures($planId, $lectures);
            DB::connection('tenant')->table('curriculum_submissions')->insert([
                'request_id' => $data['request_id'], 'created_by' => $request->user()->id,
                'branch_id' => $level['branch_id'], 'kind' => 'plan_versions', 'record_id' => $planId,
                'request_hash' => $hash, 'created_at' => now(),
            ]);
            $after = $this->read('levels', $levelId, $permissions);
            $this->audit($request, 'curriculum.plan_version_created', $level['branch_id'], 'levels', $level, $after);

            return response()->json(['plan' => $after['plan'], 'level' => $after], 201);
        });
    }

    public function updateCourseThreshold(Request $request, string $courseId): JsonResponse
    {
        return $this->updateThreshold($request, 'courses', $courseId);
    }

    public function updateStageThreshold(Request $request, string $stageId): JsonResponse
    {
        return $this->updateThreshold($request, 'stages', $stageId);
    }

    public function updateLevelThreshold(Request $request, string $levelId): JsonResponse
    {
        return $this->updateThreshold($request, 'levels', $levelId);
    }

    private function updateThreshold(Request $request, string $kind, string $id): JsonResponse
    {
        abort_unless(Str::isUuid($id), 404);
        $data = $request->validate([
            'revision' => ['required', 'integer', 'min:1'],
            'completion_threshold' => [$kind === 'courses' ? 'required' : 'present', 'nullable', 'integer', 'between:1,100'],
        ]);

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $kind, $id, $data): JsonResponse {
            $before = $this->read($kind, $id, $permissions);
            $this->authorize($permissions, $before['branch_id']);
            $row = DB::connection('tenant')->table($kind)->where('id', $id)->lockForUpdate()->first();
            if ($row->completion_revision !== (int) $data['revision']) {
                $this->conflict('curriculum_changed');
            }
            if ($row->completion_threshold == $data['completion_threshold']) {
                return response()->json(['record' => $before]);
            }
            DB::connection('tenant')->table($kind)->where('id', $id)->update([
                'completion_threshold' => $data['completion_threshold'],
                'completion_revision' => $row->completion_revision + 1, 'updated_at' => now(),
            ]);
            $after = $this->read($kind, $id, $permissions);
            $this->audit($request, 'curriculum.completion_threshold_changed', $before['branch_id'], $kind, $before, $after);

            return response()->json(['record' => $after]);
        });
    }

    private function records(string $kind, CenterPermissions $permissions, bool $includeLectures = true,
        ?int $selectedVersion = null, int $versionsPage = 1, bool $includeHistory = false): Builder
    {
        $query = DB::connection('tenant')->table('courses');
        if ($kind !== 'courses') {
            $query->join('stages', 'stages.course_id', '=', 'courses.id');
        }
        if ($kind === 'levels') {
            $query->join('levels', 'levels.stage_id', '=', 'stages.id')->join('study_plan_versions as plans', function ($join) use ($selectedVersion): void {
                $join->on('plans.level_id', '=', 'levels.id');
                if ($selectedVersion !== null) {
                    $join->where('plans.version', $selectedVersion);
                } else {
                    $join->whereRaw('plans.version = (SELECT max(latest.version) FROM study_plan_versions AS latest WHERE latest.level_id = levels.id)');
                }
            });
        }
        if (! $permissions->isCenterManager()) {
            $query->whereIn('courses.branch_id', $this->scope($permissions));
        }
        $query->select([$kind.'.id', $kind.'.name', $kind.'.completion_threshold', $kind.'.completion_revision', 'courses.branch_id']);
        if ($kind !== 'courses') {
            $query->addSelect(['stages.course_id', 'courses.name as course_name']);
        }
        if ($kind === 'levels') {
            $lecturePayload = $includeLectures ? <<<'SQL'
COALESCE((SELECT json_agg(json_build_object('id', lectures.id, 'number', lectures.number, 'content', lectures.content, 'title', lectures.title, 'planned_hours', lectures.planned_hours::float) ORDER BY lectures.number)
FROM (SELECT * FROM plan_lectures WHERE plan_version_id = plans.id ORDER BY number LIMIT 200) lectures), '[]'::json)
SQL : "'[]'::json";
            $previousLectures = $includeLectures ? <<<'SQL'
COALESCE((SELECT json_agg(json_build_object('number', lectures.number, 'content', lectures.content, 'title', lectures.title, 'planned_hours', lectures.planned_hours::float) ORDER BY lectures.number)
FROM (SELECT number, content, title, planned_hours FROM plan_lectures WHERE plan_version_id = (SELECT previous.id FROM study_plan_versions AS previous WHERE previous.level_id = levels.id AND previous.version = plans.version - 1) ORDER BY number LIMIT 200) lectures), '[]'::json)
SQL : "'[]'::json";
            $query->addSelect(['levels.stage_id', 'stages.name as stage_name'])->selectRaw(<<<SQL
json_build_object('id', plans.id, 'version', plans.version, 'revision', plans.revision, 'used_at', plans.used_at,
'lecture_count', (SELECT count(*) FROM plan_lectures WHERE plan_version_id = plans.id),
'planned_hours', (SELECT COALESCE(sum(planned_hours), 0)::float FROM plan_lectures WHERE plan_version_id = plans.id),
'lectures', {$lecturePayload}, 'previous_lectures', {$previousLectures}) AS plan,
(SELECT max(latest.version) FROM study_plan_versions AS latest WHERE latest.level_id = levels.id) AS latest_version
SQL);
            if ($includeHistory) {
                $historyOffset = ($versionsPage - 1) * 20;
                $query->selectRaw(<<<SQL
(SELECT COALESCE(json_agg(row_to_json(history) ORDER BY history.version DESC), '[]'::json) FROM (
    SELECT versions.id, versions.version, versions.revision, versions.used_at, versions.created_at,
        (SELECT count(*) FROM plan_lectures WHERE plan_version_id = versions.id) AS lecture_count,
        (SELECT COALESCE(sum(planned_hours), 0)::float FROM plan_lectures WHERE plan_version_id = versions.id) AS planned_hours
    FROM study_plan_versions AS versions WHERE versions.level_id = levels.id
    ORDER BY versions.version DESC LIMIT 21 OFFSET {$historyOffset}
) AS history)
AS plan_history
SQL);
            }
        }

        return $query;
    }

    private function read(string $kind, string $id, CenterPermissions $permissions, ?int $selectedVersion = null): array
    {
        $row = $this->records($kind, $permissions, true, $selectedVersion)->where($kind.'.id', $id)->first();
        abort_unless($row, 404);
        $record = (array) $row;
        if (isset($record['plan'])) {
            $record['plan'] = json_decode($record['plan'], true);
        }
        $record['can_manage'] = $permissions->can('curriculum.manage', $record['branch_id']);

        return $record;
    }

    private function create(Request $request, string $kind, array $data, int $branchId, CenterPermissions $permissions): JsonResponse
    {
        $hash = hash('sha256', json_encode([$kind, $data]));
        $submission = DB::connection('tenant')->table('curriculum_submissions')->where('request_id', $request->input('request_id'))->first();
        $singular = ['courses' => 'course', 'stages' => 'stage', 'levels' => 'level'][$kind];
        if ($submission) {
            abort_unless($submission->created_by === $request->user()->id, 403);
            if ($submission->request_hash !== $hash) {
                $this->conflict('curriculum_request_changed');
            }

            return response()->json([$singular => $this->read($kind, $submission->record_id, $permissions)]);
        }
        $id = (string) Str::uuid();
        $attributes = array_diff_key($data, ['lectures' => true]);
        DB::connection('tenant')->table($kind)->insert(['id' => $id, ...$attributes, 'created_at' => now(), 'updated_at' => now()]);
        if ($kind === 'levels') {
            $planId = (string) Str::uuid();
            DB::connection('tenant')->table('study_plan_versions')->insert(['id' => $planId, 'level_id' => $id, 'version' => 1, 'revision' => 1, 'created_at' => now(), 'updated_at' => now()]);
            $this->insertLectures($planId, $data['lectures']);
        }
        DB::connection('tenant')->table('curriculum_submissions')->insert([
            'request_id' => $request->input('request_id'), 'created_by' => $request->user()->id, 'branch_id' => $branchId,
            'kind' => $kind, 'record_id' => $id, 'request_hash' => $hash, 'created_at' => now(),
        ]);
        $after = $this->read($kind, $id, $permissions);
        $this->audit($request, 'curriculum.'.$singular.'_created', $branchId, $kind, null, $after);

        return response()->json([$singular => $after], 201);
    }

    private function insertLectures(string $planId, array $lectures): void
    {
        DB::connection('tenant')->table('plan_lectures')->insert(array_map(fn (array $lecture): array => ['id' => (string) Str::uuid(), 'plan_version_id' => $planId, ...$lecture], $lectures));
    }

    private function validateName(Request $request): array
    {
        $data = $request->validate(['name' => ['required', 'string', 'max:255'], 'request_id' => ['required', 'uuid']], ['name.required' => 'أدخل الاسم.']);
        $name = trim($data['name']);
        abort_if($name === '', 422, 'أدخل الاسم.');

        return ['name' => $name];
    }

    private function validateLectures(Request $request): array
    {
        $data = $request->validate([
            'lectures' => ['required', 'array', 'min:1', 'max:200'],
            'lectures.*' => ['required', 'array:number,content,title,planned_hours'],
            'lectures.*.number' => ['required', 'integer', 'min:1', 'max:200', 'distinct'],
            'lectures.*.content' => ['required', 'string', 'max:5000'],
            'lectures.*.title' => ['nullable', 'string', 'max:255'],
            'lectures.*.planned_hours' => ['required', 'numeric', 'decimal:0,2', 'gt:0', 'max:9999.99'],
        ], ['lectures.required' => 'أضف محاضرة مطلوبة كاملة واحدة على الأقل.']);
        $lectures = array_map(fn (array $lecture): array => [
            'number' => (int) $lecture['number'], 'content' => trim($lecture['content']),
            'title' => isset($lecture['title']) && trim($lecture['title']) !== '' ? trim($lecture['title']) : null,
            'planned_hours' => (float) $lecture['planned_hours'],
        ], $data['lectures']);
        usort($lectures, fn (array $left, array $right): int => $left['number'] <=> $right['number']);
        abort_unless(array_column($lectures, 'number') === range(1, count($lectures)), 422, 'رقّم المحاضرات الكاملة بالتتابع بدءًا من ١.');
        foreach ($lectures as $lecture) {
            abort_if($lecture['content'] === '', 422, 'أدخل محتوى كل محاضرة.');
        }

        return $lectures;
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

    private function authorize(CenterPermissions $permissions, int $branchId): void
    {
        abort_unless($permissions->can('curriculum.manage', $branchId), 403);
    }

    private function scope(CenterPermissions $permissions): array
    {
        return array_keys(array_filter($permissions->branchRoles, fn (array $roles): bool => in_array('read', CenterPermissions::actions($roles), true)));
    }

    private function audit(Request $request, string $event, int $branchId, string $kind, ?array $before, array $after): void
    {
        DB::connection('tenant')->table('center_audit_logs')->insert([
            'actor_id' => $request->user()->id, 'branch_id' => $branchId, 'event' => $event,
            'details' => json_encode(['kind' => $kind, 'record_id' => $after['id'], 'before' => $before, 'after' => $after]), 'created_at' => now(),
        ]);
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
