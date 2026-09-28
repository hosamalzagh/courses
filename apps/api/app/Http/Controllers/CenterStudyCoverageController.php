<?php

namespace App\Http\Controllers;

use Illuminate\Database\Query\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudyCoverageController extends Controller
{
    public function workspace(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $data = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'q' => ['nullable', 'string', 'max:255'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        $group = DB::connection('tenant')->table('study_groups as groups')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->where('groups.id', $groupId)
            ->select(['groups.id', 'groups.name', 'groups.status', 'groups.plan_version_id', 'courses.branch_id'])
            ->selectRaw('COALESCE(groups.completion_threshold, levels.completion_threshold, stages.completion_threshold, courses.completion_threshold) AS completion_threshold')
            ->selectRaw("COALESCE((SELECT json_agg(json_build_object('number', number, 'title', title, 'content', content) ORDER BY number) FROM plan_lectures WHERE plan_version_id = groups.plan_version_id), '[]'::json) AS requirements")
            ->first();
        abort_unless($group && $permissions->can('read', (int) $group->branch_id), 404);

        $requirements = json_decode($group->requirements, true);
        $requiredNumbers = array_column($requirements, 'number');
        $requiredCount = count($requiredNumbers);
        $threshold = (int) $group->completion_threshold;
        $page = (int) ($data['page'] ?? 1);
        $students = DB::connection('tenant')->table('study_attempts as attempts')
            ->join('students', 'students.id', '=', 'attempts.student_id')
            ->where('attempts.current_group_id', $groupId)
            ->where('attempts.plan_version_id', $group->plan_version_id)
            ->select(['attempts.id as attempt_id', 'attempts.status as attempt_status', 'attempts.joined_on',
                'students.id as student_id', 'students.name', 'students.student_number', 'students.status as student_status'])
            ->selectRaw(<<<'SQL'
COALESCE((SELECT json_agg(json_build_object('number', covered.number, 'final', covered.final) ORDER BY covered.number)
FROM (SELECT lectures.number, bool_or(sessions.closed_at IS NOT NULL) AS final
    FROM study_attendance_entries AS entries
    JOIN study_sessions AS sessions ON sessions.id = entries.session_id
    JOIN plan_lectures AS lectures ON lectures.id = sessions.plan_lecture_id
    WHERE entries.attempt_id = attempts.id AND entries.status = 'counted'
      AND sessions.group_id = attempts.current_group_id AND sessions.status <> 'cancelled'
      AND lectures.plan_version_id = attempts.plan_version_id
    GROUP BY lectures.number) AS covered), '[]'::json) AS coverage
SQL);
        if (isset($data['q']) && trim($data['q']) !== '') {
            $search = mb_strtolower(preg_replace('/\s+/u', ' ', trim($data['q'])));
            $number = str_replace('٬', '', strtr(trim($data['q']),
                array_combine(mb_str_split('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'), str_split('01234567890123456789'))));
            $students->where(function (Builder $query) use ($search, $number): void {
                $query->whereRaw('strpos(students.name_search, ?) > 0', [$search]);
                if (ctype_digit($number) && strlen($number) <= 18) {
                    $query->orWhere('students.student_number', (int) $number);
                }
            });
        }
        $rows = $students->orderBy('students.student_number')->orderBy('attempts.id')
            ->offset(($page - 1) * 20)->limit(21)->get();
        $report = $rows->take(20)->map(function (object $row) use ($requiredNumbers, $requiredCount, $threshold): array {
            $coverage = json_decode($row->coverage, true);
            $coveredNumbers = array_column($coverage, 'number');
            $openNumbers = array_values(array_column(array_filter($coverage, fn (array $entry): bool => ! $entry['final']), 'number'));
            $coveredCount = count($coveredNumbers);

            return [
                'attempt_id' => $row->attempt_id, 'student_id' => $row->student_id,
                'name' => $row->name, 'student_number' => $row->student_number,
                'joined_on' => $row->joined_on, 'attempt_status' => $row->attempt_status,
                'student_status' => $row->student_status,
                'covered_numbers' => $coveredNumbers,
                'missing_numbers' => array_values(array_diff($requiredNumbers, $coveredNumbers)),
                'open_numbers' => $openNumbers,
                'covered_count' => $coveredCount,
                'required_count' => $requiredCount,
                'percentage' => $requiredCount === 0 ? 0 : round($coveredCount * 100 / $requiredCount, 2),
                'eligible' => $requiredCount > 0 && $coveredCount * 100 >= $threshold * $requiredCount,
            ];
        });

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(),
            'group' => ['id' => $group->id, 'name' => $group->name, 'status' => $group->status,
                'branch_id' => $group->branch_id, 'completion_threshold' => $threshold,
                'required_count' => $requiredCount, 'requirements' => $requirements],
            'students' => $report->values(),
            'pagination' => ['page' => $page, 'has_more' => $rows->count() > 20],
        ])->header('Cache-Control', 'private, no-store');
    }
}
