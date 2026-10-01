<?php

namespace App\Support;

use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

class CurriculumExplorerRead
{
    public function __construct(private CenterPermissions $permissions) {}

    public function workspace(array $data): array
    {
        if (! isset($data['kind']) && (isset($data['stage_id']) || isset($data['course_id']))) {
            $data['kind'] = isset($data['stage_id']) ? 'stage' : 'course';
            $data['id'] = $data['stage_id'] ?? $data['course_id'];
        }
        $permissions = $this->permissions;
        $read = $this;
        $page = (int) ($data['courses_page'] ?? 1);
        $searchPage = (int) ($data['search_page'] ?? 1);
        $sessionsPage = (int) ($data['sessions_page'] ?? 1);
        $q = trim($data['q'] ?? '');
        $root = $read->courses()->orderBy('courses.created_at')->orderBy('courses.id')
            ->offset(($page - 1) * 50)->limit(51);
        $query = self::tagged($root, 'root');
        $kind = $data['kind'] ?? null;
        $selected = $kind ? $read->nodes($kind)->where(self::table($kind).'.id', $data['id']) : null;
        if ($selected) {
            foreach (['course', 'stage', 'level', 'group'] as $ancestor) {
                $table = self::table($ancestor);
                $path = $read->nodes($ancestor)->whereIn($table.'.id', (clone $selected)->select($table.'.id')->limit(1))->limit(1);
                $query->unionAll(self::tagged($path, 'path'));
                if ($ancestor === $kind) {
                    break;
                }
                $childKind = ['course' => 'stage', 'stage' => 'level', 'level' => 'group'][$ancestor];
                $childTable = self::table($childKind);
                $foreignKey = ['course' => 'stages.course_id', 'stage' => 'levels.stage_id', 'level' => 'study_groups.level_id'][$ancestor];
                $children = $read->nodes($childKind)->whereIn($foreignKey, (clone $selected)->select($table.'.id')->limit(1))
                    ->orderBy($childTable.'.created_at')->orderBy($childTable.'.id')->limit(51);
                $query->unionAll(self::tagged($children, 'children_'.$ancestor));
            }
            if ($kind === 'group') {
                $query->unionAll(self::tagged(StudySessionRead::groupQuery($data['id'], $permissions)->limit(1), 'session_group'));
                $sessions = StudySessionRead::sessionsQuery($data['id'])
                    ->whereIn('sessions.group_id', (clone $selected)->select('study_groups.id')->limit(1))
                    ->orderBy('sessions.scheduled_at')->orderBy('sessions.id')->offset(($sessionsPage - 1) * 20)->limit(21);
                $query->unionAll(self::tagged($sessions, 'session'));
                $query->unionAll(self::tagged(StudyGroupRead::studentsQuery($data['id'], $permissions)
                    ->orderBy('students.name')->orderBy('attempts.id')->offset(((int) ($data['students_page'] ?? 1) - 1) * 20)->limit(21), 'student'));
            }
        }
        $expanded = [];
        foreach (array_filter(explode(',', $data['expanded'] ?? '')) as $entry) {
            [$parentKind, $parentId, $parentPage] = explode(':', $entry);
            $key = $parentKind.':'.$parentId;
            $expanded[$key] = ['kind' => $parentKind, 'id' => $parentId, 'page' => (int) $parentPage];
        }
        foreach ($expanded as $key => $parent) {
            $childKind = ['course' => 'stage', 'stage' => 'level', 'level' => 'group'][$parent['kind']];
            $parentQuery = $read->nodes($parent['kind'])->where(self::table($parent['kind']).'.id', $parent['id'])->limit(1);
            $query->unionAll(self::tagged($parentQuery, 'expanded_parent_'.$key));
            $childQuery = $read->children($parent['kind'], $parent['id'])->orderBy(self::table($childKind).'.created_at')
                ->orderBy(self::table($childKind).'.id')->offset(($parent['page'] - 1) * 50)->limit(51);
            $query->unionAll(self::tagged($childQuery, 'expanded_child_'.$key));
        }
        // Existing record owners keep plan versions, lifecycle rules and group choices identical.
        foreach (['courses', 'stages', 'levels'] as $recordKind) {
            $detailQuery = CurriculumRecords::query($recordKind, $permissions, $kind === 'level',
                $kind === 'level' ? ($data['plan_version'] ?? null) : null, (int) ($data['versions_page'] ?? 1), $kind === 'level');
            if ($selected) {
                $ancestorTable = $recordKind === 'courses' ? 'courses' : ($recordKind === 'stages' ? 'stages' : 'levels');
                if ($recordKind === 'stages' && $kind === 'course') {
                    $detailQuery->where('stages.course_id', $data['id']);
                } elseif ($recordKind === 'levels' && $kind === 'stage') {
                    $detailQuery->where('levels.stage_id', $data['id']);
                } elseif (($recordKind === 'levels' && $kind === 'course') || ($recordKind !== 'courses' && ! $kind)) {
                    $detailQuery->whereRaw('false');
                } else {
                    $detailQuery->whereIn($ancestorTable.'.id', (clone $selected)->select($ancestorTable.'.id')->limit(1));
                }
            } elseif ($permissions->workspace?->mode === 'branch' && $recordKind !== 'courses') {
                $detailQuery->whereRaw('false');
            }
            $isAncestor = $selected && ($recordKind === 'courses' || ($recordKind === 'stages' && $kind !== 'course') || ($recordKind === 'levels' && in_array($kind, ['level', 'group'], true)));
            $detailPage = $isAncestor ? 1 : (int) ($data[$recordKind.'_page'] ?? 1);
            $query->unionAll(self::tagged($detailQuery->orderBy($recordKind.'.created_at')
                ->orderBy($recordKind.'.id')->offset(($detailPage - 1) * 50)->limit(51), 'detail_'.$recordKind));
        }
        if (in_array($kind, ['level', 'group'], true)) {
            $levelIds = (clone $selected)->select('levels.id')->limit(1);
            $groups = StudyGroupRead::groupsQuery($permissions, $kind === 'group')->whereIn('study_groups.level_id', $levelIds);
            if ($kind === 'group') {
                $groups->where('study_groups.id', $data['id']);
            }
            $query->unionAll(self::tagged($groups->orderBy('study_groups.created_at')->orderBy('study_groups.id')
                ->offset(((int) ($data['groups_page'] ?? 1) - 1) * 50)->limit(51), 'group_record'));
            $query->unionAll(self::tagged(StudyGroupRead::planChoicesQuery($permissions)->whereIn('levels.id', (clone $selected)->select('levels.id')->limit(1))
                ->orderBy('plans.version')->offset(((int) ($data['levels_page'] ?? 1) - 1) * 50)->limit(51), 'plan_choice'));
        }
        if ($permissions->workspace?->mode !== 'branch') {
            $branches = DB::connection('tenant')->table('branches')->select(['id', 'name', 'slug', 'address']);
            if (! $permissions->isCenterManager()) {
                $branches->whereIn('id', $permissions->readableBranchIds());
            }
            $query->unionAll(self::tagged($branches->orderBy('id')->offset(((int) ($data['branches_page'] ?? 1) - 1) * 50)->limit(51), 'branch'));
        }
        if ($q !== '') {
            $search = null;
            foreach (['course', 'stage', 'level', 'group'] as $searchKind) {
                $matches = $read->nodes($searchKind)->whereRaw('strpos(lower('.self::table($searchKind).'.name), lower(?)) > 0', [$q]);
                $tagged = self::tagged($matches, 'search');
                $search = $search ? $search->unionAll($tagged) : $tagged;
            }
            $query->unionAll(DB::connection('tenant')->query()->fromSub($search, 'matches')->select(['record_kind', 'payload'])
                ->orderByRaw("payload->>'name', payload->>'kind', payload->>'id'")
                ->offset(($searchPage - 1) * 50)->limit(51));
        }
        $rows = $query->get()->groupBy('record_kind');
        $payloads = fn (string $key) => ($rows->get($key) ?? collect())->map(fn ($row) => json_decode($row->payload));
        $path = $payloads('path')->map(fn ($row) => $read->present($row))->values();
        abort_if($selected && ! $path->contains(fn ($node) => $node['kind'] === $kind && $node['id'] === $data['id']), 404);
        $batches = $path->filter(fn ($node) => $node['kind'] !== $kind)->map(fn ($node) => [
            'parent' => $node, 'items' => $payloads('children_'.$node['kind'])->take(50)->map(fn ($row) => $read->present($row))->values(),
            'page' => 1, 'has_more' => $payloads('children_'.$node['kind'])->count() > 50,
        ])->values();
        $batches = $batches->keyBy(fn ($batch) => $batch['parent']['kind'].':'.$batch['parent']['id']);
        foreach ($expanded as $key => $parent) {
            $parentRow = $payloads('expanded_parent_'.$key)->first();
            // Auxiliary disclosure state can outlive deletion or access changes.
            // The scoped selected record above remains mandatory.
            if (! $parentRow) {
                continue;
            }
            $items = $payloads('expanded_child_'.$key);
            $batches->put($key, ['parent' => $read->present($parentRow), 'items' => $items->take(50)->map(fn ($row) => $read->present($row))->values(),
                'page' => $parent['page'], 'has_more' => $items->count() > 50]);
        }
        $batches = $batches->values();
        $rootRows = $payloads('root');
        $searchRows = $payloads('search');
        $pagination = [];
        $records = [];
        foreach (['courses', 'stages', 'levels'] as $recordKind) {
            $items = $payloads('detail_'.$recordKind);
            $pagination[$recordKind] = ['page' => (int) ($data[$recordKind.'_page'] ?? 1), 'has_more' => $items->count() > 50];
            $records[$recordKind] = $items->take(50)->map(function ($row) use ($recordKind, $permissions, $data) {
                $record = CurriculumRecords::present($recordKind, json_decode(json_encode($row), true), $permissions);
                if (isset($record['plan_history'])) {
                    $history = $record['plan_history'];
                    $record['plan_history'] = array_slice($history, 0, 20);
                    $record['plan_history_pagination'] = ['page' => (int) ($data['versions_page'] ?? 1), 'has_more' => count($history) > 20];
                }

                return $record;
            })->values();
        }
        abort_if($kind === 'level' && $records['levels']->isEmpty(), 404);
        $pagination['branches'] = ['page' => (int) ($data['branches_page'] ?? 1), 'has_more' => $payloads('branch')->count() > 50];
        $detail = ['curriculum' => [...$records, 'navigation' => $selected ? ['course' => $records['courses']->first(),
            'stage' => $kind !== 'course' ? $records['stages']->first() : null] : null, 'pagination' => $pagination]];
        if (in_array($kind, ['level', 'group'], true)) {
            $groupRows = $payloads('group_record');
            $level = $path->firstWhere('kind', 'level');
            $course = $path->firstWhere('kind', 'course');
            $stage = $path->firstWhere('kind', 'stage');
            $detail['groups'] = ['navigation' => ['course_id' => $course['id'], 'course_name' => $course['name'],
                'stage_id' => $stage['id'], 'stage_name' => $stage['name'], 'level_id' => $level['id'], 'level_name' => $level['name']],
                'groups' => $groupRows->take(50)->map(fn ($row) => StudyGroupRead::presentGroup($row, $permissions))->values(),
                'level_choices' => $payloads('plan_choice')->take(50)->values(),
                'pagination' => ['groups' => ['page' => (int) ($data['groups_page'] ?? 1), 'has_more' => $groupRows->count() > 50],
                    'levels' => ['page' => (int) ($data['levels_page'] ?? 1), 'has_more' => $payloads('plan_choice')->count() > 50]]];
        }

        if ($kind === 'group') {
            $sessions = $payloads('session');
            $students = $payloads('student');
            $detail['students'] = ['items' => $students->take(20)->values(), 'pagination' => ['page' => (int) ($data['students_page'] ?? 1), 'has_more' => $students->count() > 20]];
            $detail['session'] = ['group' => StudySessionRead::presentGroup($payloads('session_group')->first(), $permissions),
                'sessions' => $sessions->take(20)->values(), 'pagination' => ['page' => $sessionsPage, 'has_more' => $sessions->count() > 20]];
        }

        return [
            'branches' => $permissions->workspace?->branch ? [$permissions->workspace->branch] : $payloads('branch')->take(50)->values(),
            'tree' => [
                'root' => ['parent' => null, 'items' => $rootRows->take(50)->map(fn ($row) => $read->present($row))->values(),
                    'page' => $page, 'has_more' => $rootRows->count() > 50],
                'path' => $path, 'batches' => $batches,
                'search' => ['q' => $q, 'items' => $searchRows->take(50)->map(fn ($row) => $read->present($row))->values(),
                    'page' => $searchPage, 'has_more' => $searchRows->count() > 50],
            ],
            ...$detail,
        ];
    }

    public function courses(): Builder
    {
        return $this->nodes('course');
    }

    public function nodes(string $kind): Builder
    {
        $table = self::table($kind);
        $query = DB::connection('tenant')->table('courses');
        $path = ["jsonb_build_object('kind', 'course', 'id', courses.id, 'name', courses.name)"];
        if ($kind !== 'course') {
            $query->join('stages', 'stages.course_id', '=', 'courses.id');
            $path[] = "jsonb_build_object('kind', 'stage', 'id', stages.id, 'name', stages.name)";
        }
        if (in_array($kind, ['level', 'group'], true)) {
            $query->join('levels', 'levels.stage_id', '=', 'stages.id');
            $path[] = "jsonb_build_object('kind', 'level', 'id', levels.id, 'name', levels.name)";
        }
        if ($kind === 'group') {
            $query->join('study_groups', 'study_groups.level_id', '=', 'levels.id');
            $path[] = "jsonb_build_object('kind', 'group', 'id', study_groups.id, 'name', study_groups.name)";
        }
        $count = match ($kind) {
            'course' => '(SELECT count(*) FROM stages WHERE stages.course_id = courses.id)',
            'stage' => '(SELECT count(*) FROM levels WHERE levels.stage_id = stages.id)',
            'level' => '(SELECT count(*) FROM study_groups WHERE study_groups.level_id = levels.id)',
            'group' => '(SELECT count(*) FROM study_sessions WHERE study_sessions.group_id = study_groups.id)',
        };
        $query->select([$table.'.id', $table.'.name', 'courses.branch_id', 'courses.id as course_id']);
        if ($kind !== 'course') {
            $query->addSelect('stages.id as stage_id');
        }
        if (in_array($kind, ['level', 'group'], true)) {
            $query->addSelect('levels.id as level_id');
        }
        $records = $kind === 'group' ? StudyGroupRead::groupsQuery($this->permissions)
            : CurriculumRecords::query($kind.'s', $this->permissions, false);
        $query->joinSub($records, 'managed_record', fn ($join) => $join->on('managed_record.id', '=', $table.'.id'))
            ->selectRaw('to_jsonb(managed_record) AS record');
        $query->selectRaw('?::text AS kind, '.$count.' AS child_count, jsonb_build_array('.implode(', ', $path).') AS path', [$kind]);
        if (! $this->permissions->isCenterManager()) {
            $query->whereIn('courses.branch_id', $this->permissions->readableBranchIds());
        }
        $this->permissions->workspace?->constrain($query, 'courses.branch_id');

        return $query;
    }

    public static function table(string $kind): string
    {
        return ['course' => 'courses', 'stage' => 'stages', 'level' => 'levels', 'group' => 'study_groups'][$kind];
    }

    public function children(string $kind, string $id): Builder
    {
        $child = ['course' => 'stage', 'stage' => 'level', 'level' => 'group'][$kind];
        $column = ['course' => 'stages.course_id', 'stage' => 'levels.stage_id', 'level' => 'study_groups.level_id'][$kind];

        return $this->nodes($child)->where($column, $id);
    }

    public static function tagged(Builder $query, string $kind): Builder
    {
        return DB::connection('tenant')->query()->fromSub($query, 'records')
            ->selectRaw('?::text AS record_kind, to_jsonb(records) AS payload', [$kind]);
    }

    public function present(object $row): array
    {
        $record = is_string($row->record) ? json_decode($row->record, true) : json_decode(json_encode($row->record), true);
        $record = $row->kind === 'group' ? StudyGroupRead::presentGroup((object) $record, $this->permissions)
            : CurriculumRecords::present($row->kind.'s', $record, $this->permissions);

        return [...(array) $row, 'record' => $record, 'branch_id' => (int) $row->branch_id,
            'child_count' => (int) $row->child_count,
            'path' => is_string($row->path) ? json_decode($row->path, true) : $row->path,
            'can_manage' => $record['can_manage']];
    }
}
