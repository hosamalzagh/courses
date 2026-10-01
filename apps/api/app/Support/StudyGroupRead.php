<?php

namespace App\Support;

use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

class StudyGroupRead
{
    public static function planChoicesQuery(CenterPermissions $permissions): Builder
    {
        $query = DB::connection('tenant')->table('study_plan_versions as plans')
            ->join('levels', 'levels.id', '=', 'plans.level_id')->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')->join('branches', 'branches.id', '=', 'courses.branch_id')
            ->select(['courses.id as course_id', 'stages.id as stage_id', 'plans.id as plan_version_id', 'plans.version as plan_version',
                'plans.level_id', 'levels.name as level_name', 'courses.branch_id', 'branches.name as branch_name',
                'courses.name as course_name', 'stages.name as stage_name'])
            ->selectRaw('COALESCE(levels.completion_threshold, stages.completion_threshold, courses.completion_threshold) AS completion_threshold');
        if (! $permissions->isCenterManager()) {
            $query->whereIn('courses.branch_id', $permissions->readableBranchIds());
        }
        $permissions->workspace?->constrain($query, 'courses.branch_id');

        return $query;
    }

    public static function studentsQuery(string $groupId, CenterPermissions $permissions): Builder
    {
        return DB::connection('tenant')->table('study_attempts as attempts')
            ->join('students', 'students.id', '=', 'attempts.student_id')
            ->where('attempts.current_group_id', $groupId)
            ->whereIn('attempts.current_group_id', self::groupsQuery($permissions)->select('study_groups.id'))
            ->select(['attempts.id as attempt_id', 'students.id as student_id', 'students.name', 'students.student_number',
                'students.status as student_status', 'attempts.status', 'attempts.joined_on']);
    }

    public static function groupsQuery(CenterPermissions $permissions, bool $includeLectures = false): Builder
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
            $query->whereIn('courses.branch_id', $permissions->readableBranchIds());
        }

        $permissions->workspace?->constrain($query, 'courses.branch_id');

        return $query;
    }

    public static function presentGroup(object $row, CenterPermissions $permissions): array
    {
        return [...(array) $row, 'instructors' => is_string($row->instructors) ? json_decode($row->instructors, true) : $row->instructors,
            ...isset($row->approved_lectures) ? ['approved_lectures' => is_string($row->approved_lectures) ? json_decode($row->approved_lectures, true) : $row->approved_lectures] : [],
            'can_manage' => $permissions->can('curriculum.manage', (int) $row->branch_id)];
    }
}
