<?php

namespace App\Support;

use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

class CurriculumRecords
{
    public static function query(string $kind, CenterPermissions $permissions, bool $includeLectures = true,
        ?int $selectedVersion = null, int $versionsPage = 1, bool $includeHistory = false): Builder
    {
        $query = DB::connection('tenant')->table('courses');
        if ($kind === 'courses') {
            $query->leftJoin('curriculum_course_copies as copies', 'copies.copied_course_id', '=', 'courses.id');
        }
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
            $query->whereIn('courses.branch_id', $permissions->readableBranchIds());
        }
        $permissions->workspace?->constrain($query, 'courses.branch_id');
        $query->select([$kind.'.id', $kind.'.name', $kind.'.completion_threshold', $kind.'.completion_revision', 'courses.branch_id']);
        if ($kind === 'courses') {
            $query->selectRaw('(SELECT count(*) FROM stages AS children WHERE children.course_id = courses.id) AS stage_count,
                (SELECT count(*) FROM levels AS children JOIN stages AS parents ON parents.id = children.stage_id WHERE parents.course_id = courses.id) AS level_count,
                (SELECT count(*) FROM study_groups AS groups JOIN levels AS children ON children.id = groups.level_id JOIN stages AS parents ON parents.id = children.stage_id WHERE parents.course_id = courses.id) AS group_count');
            $query->addSelect(['copies.source_course_id', 'copies.source_course_name',
                'copies.source_branch_id', 'copies.source_branch_name']);
        }
        if ($kind !== 'courses') {
            $query->addSelect(['stages.course_id', 'courses.name as course_name']);
        }
        if ($kind === 'stages') {
            $query->selectRaw('(SELECT count(*) FROM levels AS children WHERE children.stage_id = stages.id) AS level_count,
                (SELECT count(*) FROM study_groups AS groups JOIN levels AS children ON children.id = groups.level_id WHERE children.stage_id = stages.id) AS group_count');
        }
        if ($kind === 'levels') {
            $query->selectRaw('(SELECT count(*) FROM study_groups AS groups WHERE groups.level_id = levels.id) AS group_count,
                EXISTS(SELECT 1 FROM study_plan_versions AS versions WHERE versions.level_id = levels.id AND versions.sealed_at IS NOT NULL) AS has_protected_plan,
                EXISTS(SELECT 1 FROM study_attempts AS attempts WHERE attempts.level_id = levels.id) AS has_study_records');
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

    public static function deletionBlockedReason(string $kind, array $record): ?string
    {
        if ($kind === 'courses' && $record['stage_count'] > 0) {
            return 'لا يمكن حذف الكورس لأنه يحتوي على مراحل دراسية. احذف المراحل غير المستخدمة أولًا.';
        }
        if ($kind === 'stages' && $record['level_count'] > 0) {
            return 'لا يمكن حذف المرحلة لأنها تحتوي على مستويات. احذف المستويات غير المستخدمة أولًا.';
        }
        if ($kind === 'levels' && ($record['group_count'] > 0 || $record['plan']['used_at'] !== null
            || $record['latest_version'] > 1 || $record['has_protected_plan'] || $record['has_study_records'])) {
            return 'لا يمكن حذف المستوى لارتباطه بدراسة أو بإصدارات خطة محفوظة.';
        }

        return null;
    }

    private static function hideCopySource(array &$record, CenterPermissions $permissions): void
    {
        if ($record['source_branch_id'] !== null && ! $permissions->can('read', (int) $record['source_branch_id'])) {
            $record['source_course_id'] = null;
            $record['source_course_name'] = null;
            $record['source_branch_id'] = null;
            $record['source_branch_name'] = null;
        }
    }

    public static function present(string $kind, array $record, CenterPermissions $permissions): array
    {
        foreach (['plan', 'plan_history'] as $field) {
            if (isset($record[$field]) && is_string($record[$field])) {
                $record[$field] = json_decode($record[$field], true);
            }
        }
        $record['can_manage'] = $permissions->canInWorkspace('curriculum.manage', (int) $record['branch_id']);
        $record['deletion_blocked_reason'] = self::deletionBlockedReason($kind, $record);
        $record['can_delete'] = $record['can_manage'] && $record['deletion_blocked_reason'] === null;
        if ($kind === 'courses') {
            self::hideCopySource($record, $permissions);
        }

        return $record;
    }
}
