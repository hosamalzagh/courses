<?php

namespace App\Support;

use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

class StudySessionRead
{
    public static function groupQuery(string $groupId, CenterPermissions $permissions, bool $lock = false): Builder
    {
        $query = DB::connection('tenant')->table('study_groups as groups')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->where('groups.id', $groupId)
            ->select(['groups.id', 'groups.name', 'groups.status', 'groups.revision', 'groups.plan_version_id',
                'courses.branch_id', 'courses.id as course_id', 'courses.name as course_name',
                'stages.id as stage_id', 'stages.name as stage_name', 'levels.id as level_id', 'levels.name as level_name'])
            ->selectRaw("COALESCE((SELECT json_agg(json_build_object('id', id, 'plan_lecture_id', plan_lecture_id, 'number', number, 'title', title, 'content', content) ORDER BY number) FROM (SELECT id, plan_lecture_id, number, title, content FROM study_group_requirements WHERE group_id = groups.id AND retired_at IS NULL ORDER BY number LIMIT 200) AS plan), '[]'::json) AS requirements");
        $query->selectRaw(<<<'SQL'
COALESCE((SELECT json_agg(json_build_object('id', historical.id, 'plan_lecture_id', NULL,
    'number', historical.number, 'title', historical.title, 'content', historical.content)
    ORDER BY historical.number)
    FROM (SELECT historical.id, historical.number, historical.title, historical.content
    FROM study_group_requirements AS historical
    WHERE historical.group_id = groups.id AND historical.plan_lecture_id IS NULL
        AND historical.retired_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM study_attempt_group_periods AS periods
            JOIN study_attempts AS attempts ON attempts.id = periods.attempt_id
            WHERE periods.group_id = groups.id AND attempts.status = 'withdrawn'
                AND periods.required_credit_ids @> jsonb_build_array(historical.id)
                AND COALESCE(attempts.current_group_id, (SELECT waitlists.from_group_id
                    FROM study_attempt_waitlists AS waitlists WHERE waitlists.attempt_id = attempts.id
                    ORDER BY waitlists.entry_revision DESC NULLS LAST, waitlists.entered_on DESC,
                        waitlists.created_at DESC, waitlists.id DESC LIMIT 1)) = groups.id)
    ORDER BY historical.number, historical.id LIMIT 21) AS historical), '[]'::json)
    AS historical_requirements
SQL);
        $query->selectRaw("COALESCE((SELECT json_agg(lecture_number ORDER BY lecture_number) FROM (SELECT DISTINCT lectures.number AS lecture_number FROM study_sessions AS sessions JOIN study_group_requirements AS lectures ON lectures.id = sessions.group_requirement_id WHERE sessions.group_id = groups.id AND lectures.retired_at IS NULL AND (sessions.status <> 'cancelled' OR sessions.cancelled_at IS NOT NULL) ORDER BY lecture_number LIMIT 200) AS scheduled), '[]'::json) AS scheduled_requirements");
        $query->selectRaw('(SELECT count(*) FROM study_group_requirements WHERE group_id = groups.id AND retired_at IS NULL) AS required_count');
        if ($lock) {
            $query->lockForUpdate();
        }
        if (! $permissions->isCenterManager()) {
            $query->whereIn('courses.branch_id', $permissions->readableBranchIds());
        }
        $permissions->workspace?->constrain($query, 'courses.branch_id');

        return $query;
    }

    public static function presentGroup(object $row, CenterPermissions $permissions): array
    {
        abort_unless($row && $permissions->canInWorkspace('read', (int) $row->branch_id), 404);

        $history = is_string($row->historical_requirements) ? json_decode($row->historical_requirements, true) : $row->historical_requirements;

        return [...(array) $row, 'revision' => (int) $row->revision, 'branch_id' => (int) $row->branch_id,
            'required_count' => (int) $row->required_count,
            'requirements' => is_string($row->requirements) ? json_decode($row->requirements, true) : $row->requirements,
            'historical_requirements' => array_slice($history, 0, 20),
            'historical_requirements_has_more' => count($history) > 20,
            'scheduled_requirements' => is_string($row->scheduled_requirements) ? json_decode($row->scheduled_requirements, true) : $row->scheduled_requirements,
            'can_manage' => $permissions->can('curriculum.manage', (int) $row->branch_id)];
    }

    public static function sessionsQuery(string $groupId): Builder
    {
        return DB::connection('tenant')->table('study_sessions as sessions')
            ->join('study_group_requirements as lectures', 'lectures.id', '=', 'sessions.group_requirement_id')
            ->leftJoin('study_sessions as replacements', 'replacements.replaces_session_id', '=', 'sessions.id')
            ->leftJoin('study_sessions as originals', 'originals.id', '=', 'sessions.replaces_session_id')
            ->where('sessions.group_id', $groupId)
            ->select(['sessions.id', 'sessions.number', 'sessions.title', 'sessions.scheduled_at',
                'sessions.status', 'sessions.revision', 'sessions.revoked_at', 'sessions.cancelled_at',
                'sessions.cancelled_by_name', 'sessions.cancellation_reason', 'sessions.compensation_decision',
                'sessions.replaces_session_id', 'originals.number as replaces_session_number',
                'replacements.id as replacement_id', 'replacements.number as replacement_number',
                'lectures.number as plan_lecture_number', 'lectures.content']);
    }
}
