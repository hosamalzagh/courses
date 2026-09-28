<?php

namespace App\Http\Controllers;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\StudyWaitlistEntry;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

class CenterAbsenceReviewController extends Controller
{
    public function workspace(Request $request): JsonResponse
    {
        $data = $request->validate([
            'branch_id' => ['sometimes', 'integer', 'min:1'],
            'course_id' => ['sometimes', 'uuid'], 'stage_id' => ['sometimes', 'uuid'],
            'level_id' => ['sometimes', 'uuid'], 'group_id' => ['sometimes', 'uuid'],
            'view' => ['sometimes', 'in:review,all'], 'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'q' => ['sometimes', 'string', 'max:80'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        $branches = array_map('intval', array_keys($permissions->branchRoles));
        abort_unless($permissions->isCenterManager() || count($branches) > 0, 403);
        if (isset($data['branch_id'])) {
            abort_unless($permissions->can('read', (int) $data['branch_id']), 404);
        }

        $choices = $this->options($permissions, $data);
        $rows = $this->report($permissions, $data);
        $page = (int) ($data['page'] ?? 1);

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(),
            ...$choices,
            'students' => array_slice($rows, 0, 50),
            'pagination' => ['page' => $page, 'has_more' => count($rows) > 50],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function optionsPage(Request $request): JsonResponse
    {
        $data = $request->validate([
            'branch_id' => ['sometimes', 'integer', 'min:1'],
            'q' => ['required', 'string', 'min:1', 'max:80'],
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        abort_unless($permissions->isCenterManager() || count($permissions->branchRoles) > 0, 403);
        if (isset($data['branch_id'])) {
            abort_unless($permissions->can('read', (int) $data['branch_id']), 404);
        }

        return response()->json($this->options($permissions, [
            'branch_id' => $data['branch_id'] ?? null,
            'option_q' => trim($data['q']), 'options_page' => (int) ($data['page'] ?? 1),
        ]))->header('Cache-Control', 'private, no-store');
    }

    public function updateRule(Request $request, string $kind, string $id): JsonResponse
    {
        abort_unless(in_array($kind, ['courses', 'stages', 'levels', 'study_groups'], true) && Str::isUuid($id), 404);
        $data = $request->validate([
            'mode' => ['required', 'in:inherit,disabled,consecutive,total'],
            'limit' => ['nullable', 'integer', 'between:1,999'],
            'revision' => ['required', 'integer', 'min:1'],
        ]);
        abort_if($kind === 'courses' && $data['mode'] === 'inherit', 422);
        abort_if(in_array($data['mode'], ['consecutive', 'total'], true) !== isset($data['limit']), 422);

        return DB::connection('central')->transaction(function () use ($request, $kind, $id, $data): JsonResponse {
            $center = Center::query()->whereKey($request->attributes->get('center')->id)->lockForUpdate()->firstOrFail();
            abort_if($center->suspended, 423);
            abort_unless($center->provisioning_status === 'active', 503);
            abort_unless(CenterMembership::query()->where('tenant_id', $center->id)->where('user_id', $request->user()->id)->value('status') === 'active', 403);

            return DB::connection('tenant')->transaction(function () use ($request, $kind, $id, $data): JsonResponse {
                $permissions = CenterPermissions::forUser($request->user()->id);
                $row = $this->ruleRow($kind, $id, true);
                abort_unless($row && $permissions->can('read', (int) $row->branch_id), 404);
                abort_unless($permissions->can('curriculum.manage', (int) $row->branch_id), 403);
                $before = ['mode' => $row->absence_mode, 'limit' => $row->absence_limit, 'revision' => (int) $row->absence_revision];
                $after = ['mode' => $data['mode'] === 'inherit' ? null : $data['mode'], 'limit' => isset($data['limit']) ? (int) $data['limit'] : null];
                if ($before['mode'] === $after['mode'] && $before['limit'] === $after['limit']) {
                    return response()->json(['rule' => [...$after, 'revision' => $before['revision']]])->header('Cache-Control', 'private, no-store');
                }
                if ($before['revision'] !== (int) $data['revision']) {
                    throw new HttpResponseException(response()->json(['code' => 'absence_rule_changed'], 409));
                }
                DB::connection('tenant')->table($kind)->where('id', $id)->update([
                    'absence_mode' => $after['mode'], 'absence_limit' => $after['limit'],
                    'absence_revision' => $before['revision'] + 1, 'updated_at' => now(),
                ]);
                $after['revision'] = $before['revision'] + 1;
                DB::connection('tenant')->table('center_audit_logs')->insert([
                    'actor_id' => $request->user()->id, 'branch_id' => $row->branch_id,
                    'event' => 'study_absence.rule_changed',
                    'details' => json_encode(['kind' => $kind, 'record_id' => $id, 'before' => $before, 'after' => $after]),
                    'created_at' => now(),
                ]);

                return response()->json(['rule' => $after])->header('Cache-Control', 'private, no-store');
            });
        });
    }

    public function previewWaitlistBatch(Request $request): JsonResponse
    {
        $data = $request->validate([
            'selection_mode' => ['required', 'in:selected,all'],
            'attempt_ids' => ['sometimes', 'array', 'min:1', 'max:200'],
            'attempt_ids.*' => ['required', 'uuid', 'distinct'],
            'branch_id' => ['sometimes', 'integer', 'min:1'],
            'course_id' => ['sometimes', 'uuid'], 'stage_id' => ['sometimes', 'uuid'],
            'level_id' => ['sometimes', 'uuid'], 'group_id' => ['sometimes', 'uuid'],
            'view' => ['sometimes', 'in:review,all'], 'q' => ['sometimes', 'string', 'max:80'],
            'entered_on' => ['required', 'date_format:Y-m-d', 'before_or_equal:'.now('Africa/Cairo')->toDateString()],
            'reason' => ['required', 'string', 'max:2000'],
        ]);
        $reason = trim($data['reason']);
        abort_if($reason === '', 422, 'أدخل سبب النقل إلى الانتظار.');
        $selected = $data['selection_mode'] === 'selected' ? ($data['attempt_ids'] ?? []) : [];
        abort_if($data['selection_mode'] === 'selected' && $selected === [], 422, 'اختر طالبًا واحدًا على الأقل.');
        abort_if($data['selection_mode'] === 'all' && isset($data['attempt_ids']), 422);
        $scope = array_intersect_key($data, array_flip(['branch_id', 'course_id', 'stage_id', 'level_id', 'group_id', 'view', 'q']));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $data, $reason, $selected, $scope): JsonResponse {
            if (isset($scope['branch_id'])) {
                abort_unless($permissions->can('enrollment.manage', (int) $scope['branch_id']), 404);
            }
            $batchId = (string) Str::uuid();
            $now = now();
            DB::connection('tenant')->table('study_waitlist_batches')->insert([
                'id' => $batchId, 'actor_id' => $request->user()->id, 'actor_name' => $request->user()->name,
                'selection_mode' => $data['selection_mode'], 'scope' => json_encode($scope),
                'entered_on' => $data['entered_on'], 'reason' => $reason, 'item_count' => 0,
                'created_at' => $now, 'updated_at' => $now,
            ]);

            $seen = [];
            $count = 0;
            for ($page = 1; ; $page++) {
                $rows = $this->report($permissions, [...$scope, 'page' => $page], $selected ?: null);
                $visible = array_slice($rows, 0, 50);
                foreach ($visible as $row) {
                    $seen[$row['id']] = true;
                }
                $manageable = array_values(array_filter($visible, fn (array $row) => $row['student_status'] === 'active' && $permissions->can('enrollment.manage', (int) $row['branch_id'])));
                $eligible = $this->previewEligibleIds($manageable, $data['entered_on']);
                $items = [];
                foreach ($manageable as $row) {
                    if (! isset($eligible[$row['id']])) {
                        continue;
                    }
                    $items[] = [
                        'batch_id' => $batchId, 'attempt_id' => $row['id'], 'student_id' => $row['student_id'],
                        'branch_id' => $row['branch_id'], 'group_id' => $row['current_group_id'],
                        'attempt_revision' => $row['attempt_revision'], 'student_name' => $row['student_name'],
                        'student_number' => $row['student_number'], 'status' => 'pending',
                    ];
                }
                if ($items !== []) {
                    DB::connection('tenant')->table('study_waitlist_batch_items')->insert($items);
                    $count += count($items);
                }
                if (count($rows) <= 50) {
                    break;
                }
            }
            abort_if($selected !== [] && count($seen) !== count($selected), 422, 'تغير نطاق التقرير أو لم تعد بعض الحالات ظاهرة. حدّث الصفحة وراجع الاختيار.');
            abort_if($selected !== [] && $count !== count($selected), 422, 'بعض الطلاب المحددين غير مؤهلين للنقل في التاريخ المختار أو لا تملك صلاحية تسجيلهم. راجع الاختيار والتاريخ.');
            abort_if($count === 0, 422, 'لا توجد حالات مؤهلة للنقل إلى الانتظار في النطاق المحدد.');
            DB::connection('tenant')->table('study_waitlist_batches')->where('id', $batchId)
                ->update(['item_count' => $count]);

            return $this->batchResponse($batchId, $permissions, $request->user()->id, 1, 201);
        })->header('Cache-Control', 'private, no-store');
    }

    public function showWaitlistBatch(Request $request, string $batchId): JsonResponse
    {
        abort_unless(Str::isUuid($batchId), 404);
        $data = $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);

        return $this->batchResponse($batchId, $request->attributes->get('center_permissions'),
            $request->user()->id, (int) ($data['page'] ?? 1))->header('Cache-Control', 'private, no-store');
    }

    public function executeWaitlistBatch(Request $request, string $batchId): JsonResponse
    {
        abort_unless(Str::isUuid($batchId), 404);

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $batchId): JsonResponse {
            $batch = $this->loadBatch($batchId, $permissions, $request->user()->id, true);
            $items = DB::connection('tenant')->table('study_waitlist_batch_items')
                ->where('batch_id', $batchId)->where('status', 'pending')->orderBy('id')
                ->limit(25)->lockForUpdate()->get();
            if ($items->isEmpty()) {
                return $this->batchResponse($batchId, $permissions, $request->user()->id);
            }
            $scope = json_decode($batch->scope, true, flags: JSON_THROW_ON_ERROR);
            $ids = $items->pluck('attempt_id')->all();
            $current = collect($this->report($permissions, [...$scope, 'page' => 1], $ids))->keyBy('id');
            foreach ($items as $item) {
                $row = $current->get($item->attempt_id);
                $reason = null;
                $waitlistId = null;
                if ($row === null || $row['student_status'] !== 'active' ||
                    ! $permissions->can('enrollment.manage', (int) $row['branch_id']) ||
                    (int) $row['branch_id'] !== (int) $item->branch_id ||
                    (int) $row['attempt_revision'] !== (int) $item->attempt_revision ||
                    $row['current_group_id'] !== $item->group_id) {
                    $reason = 'تغيرت حالة الطالب أو مجموعته أو نطاق التقرير منذ المعاينة.';
                } else {
                    try {
                        [$waitlist] = DB::connection('tenant')->transaction(fn () => StudyWaitlistEntry::enter(
                            $item->student_id, $item->attempt_id, $batch->entered_on, $batch->reason,
                            (int) $item->attempt_revision, (string) Str::uuid(),
                            $request->user()->id, $request->user()->name, $permissions, $batchId,
                        ));
                        $waitlistId = $waitlist->id;
                    } catch (HttpResponseException $exception) {
                        $reason = $exception->getResponse()->status() === 409
                            ? 'تغيرت حالة المحاولة أثناء التنفيذ.' : 'لم تعد الحالة مؤهلة للنقل.';
                    } catch (HttpExceptionInterface $exception) {
                        $reason = $exception->getStatusCode() === 422 && $exception->getMessage() !== ''
                            ? $exception->getMessage() : 'لم تعد الحالة مؤهلة للنقل أو تغيرت الصلاحية.';
                    }
                }
                DB::connection('tenant')->table('study_waitlist_batch_items')->where('id', $item->id)->update([
                    'status' => $waitlistId === null ? 'skipped' : 'moved',
                    'waitlist_id' => $waitlistId, 'result_reason' => $reason, 'processed_at' => now(),
                ]);
                if ($reason !== null) {
                    DB::connection('tenant')->table('center_audit_logs')->insert([
                        'actor_id' => $request->user()->id, 'branch_id' => $item->branch_id,
                        'event' => 'student.study_bulk_waitlist_skipped',
                        'details' => json_encode(['batch_id' => $batchId, 'student_id' => $item->student_id,
                            'attempt_id' => $item->attempt_id, 'reason' => $reason]),
                        'created_at' => now(),
                    ]);
                }
            }

            return $this->batchResponse($batchId, $permissions, $request->user()->id);
        })->header('Cache-Control', 'private, no-store');
    }

    private function previewEligibleIds(array $rows, string $enteredOn): array
    {
        if ($rows === []) {
            return [];
        }
        $ids = array_column($rows, 'id');
        $eligible = DB::connection('tenant')->table('study_attempt_group_periods as periods')
            ->join('study_attempts as attempts', 'attempts.id', '=', 'periods.attempt_id')
            ->whereIn('periods.attempt_id', $ids)->whereNull('periods.left_on')
            ->whereColumn('periods.group_id', 'attempts.current_group_id')
            ->where('periods.joined_on', '<=', $enteredOn)
            ->whereNotExists(function ($query) use ($enteredOn): void {
                $query->selectRaw('1')->from('study_attendance_entries as entries')
                    ->join('study_sessions as sessions', 'sessions.id', '=', 'entries.session_id')
                    ->whereColumn('entries.attempt_id', 'periods.attempt_id')
                    ->whereColumn('sessions.group_id', 'periods.group_id')
                    ->whereNotNull('entries.status')
                    ->where('sessions.status', '<>', 'cancelled')
                    ->whereRaw("(sessions.scheduled_at AT TIME ZONE 'Africa/Cairo')::date >= ?::date", [$enteredOn]);
            })
            ->pluck('periods.attempt_id')->all();

        return array_fill_keys($eligible, true);
    }

    private function loadBatch(string $batchId, CenterPermissions $permissions, int $actorId, bool $lock = false): object
    {
        $query = DB::connection('tenant')->table('study_waitlist_batches')
            ->where('id', $batchId)->where('actor_id', $actorId);
        $batch = ($lock ? $query->lockForUpdate() : $query)->first();
        abort_unless($batch, 404);
        $branches = DB::connection('tenant')->table('study_waitlist_batch_items')
            ->where('batch_id', $batchId)->distinct()->pluck('branch_id');
        foreach ($branches as $branchId) {
            abort_unless($permissions->can('enrollment.manage', (int) $branchId), 404);
        }

        return $batch;
    }

    private function batchResponse(string $batchId, CenterPermissions $permissions, int $actorId, int $page = 1, int $status = 200): JsonResponse
    {
        $batch = $this->loadBatch($batchId, $permissions, $actorId);
        $counts = DB::connection('tenant')->table('study_waitlist_batch_items')->where('batch_id', $batchId)
            ->selectRaw("count(*) FILTER (WHERE status = 'pending') AS pending, count(*) FILTER (WHERE status = 'moved') AS moved, count(*) FILTER (WHERE status = 'skipped') AS skipped")
            ->first();
        $items = DB::connection('tenant')->table('study_waitlist_batch_items')
            ->where('batch_id', $batchId)->orderBy('id')->offset(($page - 1) * 50)->limit(51)
            ->get(['attempt_id', 'student_id', 'student_name', 'student_number', 'branch_id', 'status', 'result_reason', 'waitlist_id']);

        return response()->json([
            'batch' => ['id' => $batch->id, 'selection_mode' => $batch->selection_mode,
                'scope' => json_decode($batch->scope, true, flags: JSON_THROW_ON_ERROR),
                'entered_on' => $batch->entered_on, 'reason' => $batch->reason,
                'total' => (int) $batch->item_count, 'pending' => (int) $counts->pending,
                'moved' => (int) $counts->moved, 'skipped' => (int) $counts->skipped],
            'items' => $items->take(50)->values(),
            'pagination' => ['page' => $page, 'has_more' => $items->count() > 50],
        ], $status);
    }

    private function ruleRow(string $kind, string $id, bool $lock): ?object
    {
        $query = DB::connection('tenant')->table($kind);
        if ($kind === 'courses') {
            $query->select('courses.*', 'courses.branch_id');
        } elseif ($kind === 'stages') {
            $query->join('courses', 'courses.id', '=', 'stages.course_id')->select('stages.*', 'courses.branch_id');
        } elseif ($kind === 'levels') {
            $query->join('stages', 'stages.id', '=', 'levels.stage_id')->join('courses', 'courses.id', '=', 'stages.course_id')->select('levels.*', 'courses.branch_id');
        } else {
            $query->join('levels', 'levels.id', '=', 'study_groups.level_id')->join('stages', 'stages.id', '=', 'levels.stage_id')
                ->join('courses', 'courses.id', '=', 'stages.course_id')->select('study_groups.*', 'courses.branch_id');
        }

        return $query->where("{$kind}.id", $id)->when($lock, fn ($query) => $query->lockForUpdate())->first();
    }

    private function options(CenterPermissions $permissions, array $data): array
    {
        $scope = $this->scopeSql($permissions, 'courses.branch_id');
        $branchScope = $this->scopeSql($permissions, 'branches.id');
        $sql = <<<SQL
WITH nodes AS (
 SELECT 'branches' AS kind, branches.id::text AS id, branches.name, branches.id AS branch_id, branches.name AS branch_name,
   branches.slug, branches.address,
   NULL::uuid AS course_id, NULL::uuid AS stage_id, NULL::uuid AS level_id,
   NULL::text AS course_name, NULL::text AS stage_name, NULL::text AS level_name,
   NULL::varchar(20) AS absence_mode, NULL::smallint AS absence_limit, NULL::integer AS absence_revision FROM branches WHERE {$branchScope['sql']}
 UNION ALL
 SELECT 'courses' AS kind, courses.id::text, courses.name, courses.branch_id, branches.name AS branch_name,
   NULL::text, NULL::text,
   NULL::uuid AS course_id, NULL::uuid AS stage_id, NULL::uuid AS level_id,
   courses.name, NULL::text, NULL::text,
   courses.absence_mode, courses.absence_limit, courses.absence_revision FROM courses JOIN branches ON branches.id = courses.branch_id WHERE {$scope['sql']}
 UNION ALL
 SELECT 'stages', stages.id::text, stages.name, courses.branch_id, branches.name, NULL::text, NULL::text, courses.id, NULL::uuid, NULL::uuid,
   courses.name, stages.name, NULL::text,
   stages.absence_mode, stages.absence_limit, stages.absence_revision FROM stages JOIN courses ON courses.id = stages.course_id JOIN branches ON branches.id = courses.branch_id WHERE {$scope['sql']}
 UNION ALL
 SELECT 'levels', levels.id::text, levels.name, courses.branch_id, branches.name, NULL::text, NULL::text, courses.id, stages.id, NULL::uuid,
   courses.name, stages.name, levels.name,
   levels.absence_mode, levels.absence_limit, levels.absence_revision FROM levels JOIN stages ON stages.id = levels.stage_id JOIN courses ON courses.id = stages.course_id JOIN branches ON branches.id = courses.branch_id WHERE {$scope['sql']}
 UNION ALL
 SELECT 'study_groups', study_groups.id::text, study_groups.name, courses.branch_id, branches.name, NULL::text, NULL::text, courses.id, stages.id, levels.id,
   courses.name, stages.name, levels.name,
   study_groups.absence_mode, study_groups.absence_limit, study_groups.absence_revision FROM study_groups JOIN levels ON levels.id = study_groups.level_id JOIN stages ON stages.id = levels.stage_id JOIN courses ON courses.id = stages.course_id JOIN branches ON branches.id = courses.branch_id WHERE {$scope['sql']}
), bounded AS (
 SELECT nodes.*, row_number() OVER (PARTITION BY kind ORDER BY name, id) AS ordinal FROM nodes
 WHERE (?::bigint IS NULL OR branch_id = ?::bigint)
   AND (?::text IS NULL OR name ILIKE '%' || ?::text || '%')
)
SELECT * FROM bounded WHERE (ordinal > ? AND ordinal <= ?) OR id IN (?::text, ?::text, ?::text, ?::text) ORDER BY kind, name, id
SQL;
        $bindings = [...$branchScope['bindings'], ...array_merge(...array_fill(0, 4, $scope['bindings']))];
        $branch = $data['branch_id'] ?? null;
        $search = $data['option_q'] ?? null;
        $offset = ((int) ($data['options_page'] ?? 1) - 1) * 50;
        $bindings = [...$bindings, $branch, $branch, $search, $search, $offset, $offset + 50,
            $data['course_id'] ?? null, $data['stage_id'] ?? null, $data['level_id'] ?? null, $data['group_id'] ?? null];

        $rows = array_map(fn ($row) => (array) $row, DB::connection('tenant')->select($sql, $bindings));

        return [
            'branches' => array_values(array_map(fn ($row) => ['id' => (int) $row['branch_id'], 'name' => $row['name'], 'slug' => $row['slug'], 'address' => $row['address']],
                array_filter($rows, fn ($row) => $row['kind'] === 'branches'))),
            'options' => array_values(array_map(
                fn ($row) => array_intersect_key($row, array_flip(['kind', 'id', 'name', 'branch_id', 'branch_name',
                    'course_id', 'stage_id', 'level_id', 'course_name', 'stage_name', 'level_name',
                    'absence_mode', 'absence_limit', 'absence_revision'])),
                array_filter($rows, fn ($row) => $row['kind'] !== 'branches')
            )),
        ];
    }

    private function report(CenterPermissions $permissions, array $data, ?array $attemptIds = null): array
    {
        $scope = $this->scopeSql($permissions, 'courses.branch_id');
        $periodScope = $this->scopeSql($permissions, 'period_courses.branch_id');
        $sql = <<<SQL
WITH candidates AS (
 SELECT attempts.id, attempts.student_id, students.name AS student_name, students.student_number,
   students.status AS student_status, attempts.revision AS attempt_revision, attempts.current_group_id,
   courses.branch_id, branches.name AS branch_name, courses.name AS course_name,
   stages.name AS stage_name, levels.name AS level_name, study_groups.name AS group_name,
   COALESCE(study_groups.absence_mode, levels.absence_mode, stages.absence_mode, courses.absence_mode) AS effective_mode,
   CASE WHEN study_groups.absence_mode IS NOT NULL THEN study_groups.absence_limit
        WHEN levels.absence_mode IS NOT NULL THEN levels.absence_limit
        WHEN stages.absence_mode IS NOT NULL THEN stages.absence_limit ELSE courses.absence_limit END AS effective_limit
 FROM study_attempts attempts
 JOIN students ON students.id = attempts.student_id
 JOIN study_groups ON study_groups.id = attempts.current_group_id
 JOIN levels ON levels.id = study_groups.level_id
 JOIN stages ON stages.id = levels.stage_id
 JOIN courses ON courses.id = stages.course_id
 JOIN branches ON branches.id = courses.branch_id
 WHERE attempts.status = 'active' AND {$scope['sql']}
   AND (?::uuid[] IS NULL OR attempts.id = ANY(?::uuid[]))
   AND (?::bigint IS NULL OR courses.branch_id = ?::bigint)
   AND (?::uuid IS NULL OR courses.id = ?::uuid)
   AND (?::uuid IS NULL OR stages.id = ?::uuid)
   AND (?::uuid IS NULL OR levels.id = ?::uuid)
   AND (?::uuid IS NULL OR study_groups.id = ?::uuid)
   AND (?::text IS NULL OR students.name ILIKE '%' || ?::text || '%'
        OR (?::bigint IS NOT NULL AND students.student_number = ?::bigint))
), eligible AS (
 SELECT c.id AS attempt_id, periods.id AS period_id, periods.left_on IS NULL AS current_period,
   entries.status, sessions.scheduled_at, sessions.id AS session_id
 FROM candidates c
 JOIN study_attempt_group_periods periods ON periods.attempt_id = c.id
 JOIN study_groups period_groups ON period_groups.id = periods.group_id
 JOIN levels period_levels ON period_levels.id = period_groups.level_id
 JOIN stages period_stages ON period_stages.id = period_levels.stage_id
 JOIN courses period_courses ON period_courses.id = period_stages.course_id
 JOIN study_sessions sessions ON sessions.group_id = periods.group_id
   AND (sessions.scheduled_at AT TIME ZONE 'Africa/Cairo')::date >= periods.joined_on
   AND (periods.left_on IS NULL OR (sessions.scheduled_at AT TIME ZONE 'Africa/Cairo')::date < periods.left_on)
   AND sessions.status = 'held' AND sessions.closed_at IS NOT NULL
 JOIN study_attendance_entries entries ON entries.session_id = sessions.id AND entries.attempt_id = c.id
 WHERE entries.status IS NOT NULL AND {$periodScope['sql']}
), ranked AS (
 SELECT eligible.*, count(*) FILTER (WHERE status <> 'absent') OVER
   (PARTITION BY attempt_id, period_id ORDER BY scheduled_at DESC, session_id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS breaks
 FROM eligible
), stats AS (
 SELECT attempt_id,
   count(*) FILTER (WHERE current_period AND status = 'absent') AS total_absences,
   count(*) FILTER (WHERE current_period AND status = 'absent' AND breaks = 0) AS consecutive_absences,
   count(*) FILTER (WHERE NOT current_period AND status = 'absent') AS historical_absences
 FROM ranked GROUP BY attempt_id
), calculated AS (
 SELECT c.*, COALESCE(stats.total_absences, 0) AS total_absences,
   COALESCE(stats.consecutive_absences, 0) AS consecutive_absences,
   COALESCE(stats.historical_absences, 0) AS historical_absences,
   (c.effective_mode <> 'disabled' AND c.effective_limit IS NOT NULL AND
     CASE WHEN c.effective_mode = 'total' THEN COALESCE(stats.total_absences, 0)
          ELSE COALESCE(stats.consecutive_absences, 0) END >= c.effective_limit) AS needs_review
 FROM candidates c LEFT JOIN stats ON stats.attempt_id = c.id
)
SELECT id, student_id, student_name, student_number, student_status, attempt_revision, current_group_id,
  branch_id, branch_name, course_name, stage_name,
  level_name, group_name, effective_mode, effective_limit, total_absences, consecutive_absences,
  historical_absences, needs_review
FROM calculated WHERE (?::text = 'all' OR needs_review)
ORDER BY student_name, student_number, id OFFSET ? LIMIT 51
SQL;
        $idArray = $attemptIds === null ? null : '{'.implode(',', $attemptIds).'}';
        $bindings = [...$scope['bindings'], $idArray, $idArray];
        foreach (['branch_id', 'course_id', 'stage_id', 'level_id', 'group_id'] as $key) {
            $value = $data[$key] ?? null;
            $bindings[] = $value;
            $bindings[] = $value;
        }
        $search = trim($data['q'] ?? '') ?: null;
        $digits = $search === null ? null : strtr($search,
            array_combine(mb_str_split('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'), str_split('01234567890123456789')));
        $digits = $digits === null ? null : str_replace([',', '٬'], '', $digits);
        $number = $digits !== null && ctype_digit($digits) && strlen($digits) <= 18 ? $digits : null;
        $bindings = [...$bindings, $search, $search, $number, $number];
        $bindings = [...$bindings, ...$periodScope['bindings']];
        $bindings[] = $data['view'] ?? 'review';
        $bindings[] = ((int) ($data['page'] ?? 1) - 1) * 50;

        return array_map(fn ($row) => (array) $row, DB::connection('tenant')->select($sql, $bindings));
    }

    private function scopeSql(CenterPermissions $permissions, string $column): array
    {
        if ($permissions->isCenterManager()) {
            return ['sql' => 'TRUE', 'bindings' => []];
        }
        $ids = array_values(array_map('intval', array_filter(array_keys($permissions->branchRoles), fn ($id) => $permissions->can('read', (int) $id))));

        return ['sql' => $ids ? "{$column} IN (".implode(', ', array_fill(0, count($ids), '?')).')' : 'FALSE', 'bindings' => $ids];
    }
}
