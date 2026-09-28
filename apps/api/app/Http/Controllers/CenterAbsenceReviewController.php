<?php

namespace App\Http\Controllers;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Support\CenterPermissions;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

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

        $options = $this->options($permissions, $data);
        $rows = $this->report($permissions, $data);
        $page = (int) ($data['page'] ?? 1);

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(),
            'options' => $options,
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

        return response()->json(['options' => $this->options($permissions, [
            'branch_id' => $data['branch_id'] ?? null,
            'option_q' => trim($data['q']), 'options_page' => (int) ($data['page'] ?? 1),
        ])])->header('Cache-Control', 'private, no-store');
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
        $sql = <<<SQL
WITH nodes AS (
 SELECT 'courses' AS kind, courses.id, courses.name, courses.branch_id, branches.name AS branch_name,
   NULL::uuid AS course_id, NULL::uuid AS stage_id, NULL::uuid AS level_id,
   courses.absence_mode, courses.absence_limit, courses.absence_revision FROM courses JOIN branches ON branches.id = courses.branch_id WHERE {$scope['sql']}
 UNION ALL
 SELECT 'stages', stages.id, stages.name, courses.branch_id, branches.name, courses.id, NULL::uuid, NULL::uuid,
   stages.absence_mode, stages.absence_limit, stages.absence_revision FROM stages JOIN courses ON courses.id = stages.course_id JOIN branches ON branches.id = courses.branch_id WHERE {$scope['sql']}
 UNION ALL
 SELECT 'levels', levels.id, levels.name, courses.branch_id, branches.name, courses.id, stages.id, NULL::uuid,
   levels.absence_mode, levels.absence_limit, levels.absence_revision FROM levels JOIN stages ON stages.id = levels.stage_id JOIN courses ON courses.id = stages.course_id JOIN branches ON branches.id = courses.branch_id WHERE {$scope['sql']}
 UNION ALL
 SELECT 'study_groups', study_groups.id, study_groups.name, courses.branch_id, branches.name, courses.id, stages.id, levels.id,
   study_groups.absence_mode, study_groups.absence_limit, study_groups.absence_revision FROM study_groups JOIN levels ON levels.id = study_groups.level_id JOIN stages ON stages.id = levels.stage_id JOIN courses ON courses.id = stages.course_id JOIN branches ON branches.id = courses.branch_id WHERE {$scope['sql']}
), bounded AS (
 SELECT nodes.*, row_number() OVER (PARTITION BY kind ORDER BY name, id) AS ordinal FROM nodes
 WHERE (?::bigint IS NULL OR branch_id = ?::bigint)
   AND (?::text IS NULL OR name ILIKE '%' || ?::text || '%')
)
SELECT * FROM bounded WHERE (ordinal > ? AND ordinal <= ?) OR id IN (?::uuid, ?::uuid, ?::uuid, ?::uuid) ORDER BY kind, name, id
SQL;
        $bindings = array_merge(...array_fill(0, 4, $scope['bindings']));
        $branch = $data['branch_id'] ?? null;
        $search = $data['option_q'] ?? null;
        $offset = ((int) ($data['options_page'] ?? 1) - 1) * 50;
        $bindings = [...$bindings, $branch, $branch, $search, $search, $offset, $offset + 50,
            $data['course_id'] ?? null, $data['stage_id'] ?? null, $data['level_id'] ?? null, $data['group_id'] ?? null];

        return array_map(fn ($row) => (array) $row, DB::connection('tenant')->select($sql, $bindings));
    }

    private function report(CenterPermissions $permissions, array $data): array
    {
        $scope = $this->scopeSql($permissions, 'courses.branch_id');
        $periodScope = $this->scopeSql($permissions, 'period_courses.branch_id');
        $sql = <<<SQL
WITH candidates AS (
 SELECT attempts.id, attempts.student_id, students.name AS student_name, students.student_number,
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
   AND (?::bigint IS NULL OR courses.branch_id = ?::bigint)
   AND (?::uuid IS NULL OR courses.id = ?::uuid)
   AND (?::uuid IS NULL OR stages.id = ?::uuid)
   AND (?::uuid IS NULL OR levels.id = ?::uuid)
   AND (?::uuid IS NULL OR study_groups.id = ?::uuid)
   AND (?::text IS NULL OR students.name ILIKE '%' || ?::text || '%')
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
SELECT id, student_id, student_name, student_number, branch_id, branch_name, course_name, stage_name,
  level_name, group_name, effective_mode, effective_limit, total_absences, consecutive_absences,
  historical_absences, needs_review
FROM calculated WHERE (?::text = 'all' OR needs_review)
ORDER BY student_name, student_number, id OFFSET ? LIMIT 51
SQL;
        $bindings = $scope['bindings'];
        foreach (['branch_id', 'course_id', 'stage_id', 'level_id', 'group_id', 'q'] as $key) {
            $value = $data[$key] ?? null;
            $bindings[] = $value;
            $bindings[] = $value;
        }
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
