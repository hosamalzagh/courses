<?php

namespace App\Http\Controllers;

use Illuminate\Database\Query\JoinClause;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterCourseCompletionController extends Controller
{
    public function show(Request $request, string $studentId, string $courseId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($courseId), 404);
        $data = $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'q' => ['sometimes', 'string', 'max:100']]);
        $permissions = $request->attributes->get('center_permissions');
        $db = DB::connection('tenant');
        $course = $db->table('courses')
            ->join('branches', 'branches.id', '=', 'courses.branch_id')
            ->join('student_branches', 'student_branches.branch_id', '=', 'courses.branch_id')
            ->join('students', 'students.id', '=', 'student_branches.student_id')
            ->where('courses.id', $courseId)->where('students.id', $studentId)
            ->first(['courses.id', 'courses.name', 'courses.branch_id', 'branches.name as branch_name',
                'students.name as student_name', 'students.student_number']);
        abort_unless($course && $permissions->canInWorkspace('read', (int) $course->branch_id), 404);

        $countsQuery = $db->table('levels')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->where('stages.course_id', $courseId)
            ->selectRaw(<<<'SQL'
COUNT(*) AS required_levels,
COUNT(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM study_attempts AS attempts
    JOIN study_attempt_completion_decisions AS decisions ON decisions.attempt_id = attempts.id
    WHERE attempts.student_id = ? AND attempts.level_id = levels.id
      AND attempts.branch_id = ? AND attempts.status = 'completed'
      AND decisions.student_id = attempts.student_id AND decisions.branch_id = attempts.branch_id
)) AS completed_levels
SQL, [$studentId, $course->branch_id]);

        $page = (int) ($data['page'] ?? 1);
        $search = trim($data['q'] ?? '');
        $pageQuery = $db->table('levels')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->where('stages.course_id', $courseId)
            ->when($search !== '', fn ($query) => $query->where(function ($matched) use ($search): void {
                $term = '%'.addcslashes($search, '%_\\').'%';
                $matched->where('levels.name', 'ILIKE', $term)->orWhere('stages.name', 'ILIKE', $term);
            }))
            ->select(['levels.id', 'levels.name', 'levels.created_at as level_created_at',
                'stages.id as stage_id', 'stages.name as stage_name', 'stages.created_at as stage_created_at'])
            ->selectRaw(<<<'SQL'
(SELECT row_to_json(chosen) FROM (
    SELECT attempts.id, attempts.status, attempts.current_group_id, groups.name AS group_name,
        decisions.approved_at, decisions.approved_by_name, decisions.exceptional, decisions.reason,
        decisions.covered_count, decisions.required_count, decisions.completion_threshold,
        decisions.missing_numbers
    FROM study_attempts AS attempts
    LEFT JOIN study_attempt_completion_decisions AS decisions ON decisions.attempt_id = attempts.id
        AND decisions.student_id = attempts.student_id AND decisions.branch_id = attempts.branch_id
    LEFT JOIN study_groups AS groups ON groups.id = attempts.current_group_id
    WHERE attempts.student_id = ? AND attempts.level_id = levels.id AND attempts.branch_id = ?
    ORDER BY (decisions.id IS NOT NULL AND attempts.status = 'completed') DESC,
        decisions.approved_at DESC NULLS LAST, attempts.created_at DESC, attempts.id DESC
    LIMIT 1
) AS chosen) AS latest_attempt
SQL, [$studentId, $course->branch_id])
            ->orderBy('stages.created_at')->orderBy('stages.id')
            ->orderBy('levels.created_at')->orderBy('levels.id')
            ->offset(($page - 1) * 50)->limit(51);
        $result = $db->query()->fromSub($countsQuery, 'summary')
            ->leftJoinSub($pageQuery, 'page_rows', fn (JoinClause $join) => $join->on(DB::raw('1'), '=', DB::raw('1')))
            ->select(['summary.required_levels', 'summary.completed_levels', 'page_rows.id', 'page_rows.name',
                'page_rows.stage_id', 'page_rows.stage_name', 'page_rows.latest_attempt'])
            ->orderBy('page_rows.stage_created_at')->orderBy('page_rows.stage_id')
            ->orderBy('page_rows.level_created_at')->orderBy('page_rows.id')->get();
        $counts = $result->first();
        $rows = $result->filter(fn (object $row): bool => $row->id !== null)->values();

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(),
            'student' => ['id' => $studentId, 'name' => $course->student_name,
                'student_number' => (int) $course->student_number],
            'course' => ['id' => $course->id, 'name' => $course->name,
                'branch_id' => (int) $course->branch_id, 'branch_name' => $course->branch_name,
                'required_levels' => (int) $counts->required_levels,
                'completed_levels' => (int) $counts->completed_levels,
                'completed' => (int) $counts->required_levels > 0
                    && (int) $counts->required_levels === (int) $counts->completed_levels],
            'levels' => $rows->take(50)->map(fn (object $row): array => [
                'id' => $row->id, 'name' => $row->name,
                'stage_id' => $row->stage_id, 'stage_name' => $row->stage_name,
                'attempt' => $row->latest_attempt === null ? null : json_decode($row->latest_attempt, true),
            ])->values(),
            'pagination' => ['page' => $page, 'has_more' => $rows->count() > 50],
        ])->header('Cache-Control', 'private, no-store');
    }
}
