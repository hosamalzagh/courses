<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\StudyCoverageCredits;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterGroupRequirementController extends Controller
{
    public function preview(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $change = $this->change($request);
        $filters = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'q' => ['nullable', 'string', 'max:255'],
        ]);
        $page = (int) ($filters['page'] ?? 1);
        $permissions = $request->attributes->get('center_permissions');
        $group = $this->group($groupId, $permissions);
        abort_unless($permissions->canInWorkspace('curriculum.manage', $group->branch_id), 403);
        abort_if($group->status === 'completed', 409, 'لا يمكن تغيير متطلبات مجموعة مكتملة.');
        $impact = $this->impact($group, $change, $page, trim($filters['q'] ?? ''));

        return response()->json($impact)->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $change = $this->change($request);
        $confirmation = $request->validate([
            'group_revision' => ['required', 'integer', 'min:1'],
            'preview_token' => ['required', 'string', 'size:64'],
            'request_id' => ['required', 'uuid'],
        ]);
        $hash = hash('sha256', json_encode([$groupId, $change, $confirmation['preview_token']]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $groupId, $change, $confirmation, $hash): JsonResponse {
            $group = $this->group($groupId, $permissions, true);
            abort_unless($permissions->canInWorkspace('curriculum.manage', $group->branch_id), 403);
            $db = DB::connection('tenant');
            $previous = $db->table('study_group_requirement_submissions')
                ->where('request_id', $confirmation['request_id'])->first();
            if ($previous) {
                abort_unless($previous->group_id === $groupId && (int) $previous->actor_id === $request->user()->id, 403);
                if ($previous->kind !== $change['kind'] || $previous->request_hash !== $hash) {
                    $this->conflict('requirement_request_changed');
                }

                return response()->json(json_decode($previous->result, true))
                    ->header('Cache-Control', 'private, no-store');
            }
            abort_if($group->status === 'completed', 409, 'لا يمكن تغيير متطلبات مجموعة مكتملة.');
            if ((int) $group->revision !== (int) $confirmation['group_revision']) {
                $this->conflict('group_changed');
            }
            $impact = $this->impact($group, $change);
            if (! hash_equals($impact['preview_token'], $confirmation['preview_token'])) {
                $this->conflict('requirement_preview_changed');
            }
            $actor = $request->user();
            $now = now();
            $this->persistImpactHistory($group, $impact, $confirmation['request_id'], $now);
            $session = null;
            if ($change['kind'] === 'add') {
                $requirementId = (string) Str::uuid();
                $db->table('study_group_requirements')->insert([
                    'id' => $requirementId, 'group_id' => $groupId, 'plan_lecture_id' => null,
                    'number' => $impact['after']['last_number'], 'content' => $change['content'],
                    'title' => $change['title'], 'planned_hours' => null,
                    'created_by' => $actor->id, 'created_at' => $now,
                ]);
            } else {
                $session = $impact['session'];
                $requirementId = $session['group_requirement_id'];
                $previousDecision = $session['compensation_decision'];
                if ($session['status'] === 'planned') {
                    $db->table('study_sessions')->where('id', $session['id'])->update([
                        'status' => 'cancelled', 'revision' => $session['revision'] + 1,
                        'cancelled_at' => $now, 'cancelled_by' => $actor->id,
                        'cancelled_by_name' => $actor->name, 'cancellation_reason' => $change['reason'],
                        'compensation_decision' => $change['decision'], 'updated_at' => $now,
                    ]);
                    $db->table('center_audit_logs')->insert([
                        'actor_id' => $actor->id, 'branch_id' => $group->branch_id,
                        'event' => 'study_session.cancelled', 'created_at' => $now,
                        'details' => json_encode(['group_id' => $groupId, 'session_id' => $session['id'],
                            'group_requirement_id' => $requirementId, 'scheduled_at' => $session['scheduled_at'],
                            'reason' => $change['reason'], 'decision' => $change['decision'],
                            'before' => 'planned', 'after' => 'cancelled']),
                    ]);
                    $session['status'] = 'cancelled';
                    $session['revision']++;
                    $session['compensation_decision'] = $change['decision'];
                } elseif ($previousDecision === 'academic') {
                    $db->table('study_sessions')->where('id', $session['id'])->update([
                        'compensation_decision' => $change['decision'],
                        'revision' => $session['revision'] + 1, 'updated_at' => $now,
                    ]);
                    $session['revision']++;
                    $session['compensation_decision'] = $change['decision'];
                }
                $db->table('study_group_requirements')->where('id', $requirementId)->update(['retired_at' => $now]);
            }
            $db->table('study_groups')->where('id', $groupId)->update([
                'revision' => $group->revision + 1, 'updated_at' => $now,
            ]);
            $requirement = $db->table('study_group_requirements')->where('id', $requirementId)->firstOrFail();
            $result = ['requirement' => $requirement, 'session' => $session,
                'before' => $impact['before'], 'after' => $impact['after'],
                'students' => $impact['students'], 'pagination' => $impact['pagination'],
                'group_revision' => $group->revision + 1];
            $db->table('study_group_requirement_submissions')->insert([
                'request_id' => $confirmation['request_id'], 'group_id' => $groupId,
                'requirement_id' => $requirementId, 'kind' => $change['kind'],
                'request_hash' => $hash, 'actor_id' => $actor->id,
                'result' => json_encode($result), 'created_at' => $now,
            ]);
            $db->table('center_audit_logs')->insert([
                'actor_id' => $actor->id, 'branch_id' => $group->branch_id,
                'event' => 'study_group.requirements_changed', 'created_at' => $now,
                'details' => json_encode(['group_id' => $groupId, 'kind' => $change['kind'],
                    'request_id' => $confirmation['request_id'],
                    'requirement_id' => $requirementId, 'session_id' => $session['id'] ?? null,
                    'reason' => $change['reason'], 'previous_decision' => $previousDecision ?? null,
                    'decision' => $change['decision'] ?? null,
                    'before' => $impact['before'], 'after' => $impact['after'],
                    'affected_attempts' => $impact['affected_total']]),
            ]);

            return response()->json($result, $change['kind'] === 'add' ? 201 : 200)
                ->header('Cache-Control', 'private, no-store');
        });
    }

    private function change(Request $request): array
    {
        $data = $request->validate([
            'kind' => ['required', 'in:add,reduce'],
            'reason' => ['required', 'string', 'min:3', 'max:1000'],
            'content' => ['nullable', 'string', 'max:2000'],
            'title' => ['nullable', 'string', 'max:255'],
            'session_id' => ['nullable', 'uuid'],
            'decision' => ['nullable', 'in:financial,none'],
        ]);
        $data['reason'] = trim($data['reason']);
        abort_if(mb_strlen($data['reason']) < 3, 422, 'أدخل سبب تغيير العدد المعتمد.');
        if ($data['kind'] === 'add') {
            $data['content'] = trim($data['content'] ?? '');
            abort_if($data['content'] === '', 422, 'أدخل محتوى المحاضرة الإضافية.');
            $data['title'] = trim($data['title'] ?? '') ?: null;
            unset($data['session_id'], $data['decision']);
        } else {
            abort_unless(isset($data['session_id']) && isset($data['decision']), 422,
                'حدد الموعد الملغى وقرار التعويض.');
            unset($data['content'], $data['title']);
        }

        return $data;
    }

    private function group(string $groupId, CenterPermissions $permissions, bool $lock = false): object
    {
        $query = DB::connection('tenant')->table('study_groups as groups')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->where('groups.id', $groupId)
            ->select(['groups.id', 'groups.status', 'groups.revision', 'groups.plan_version_id', 'courses.branch_id']);
        if ($lock) {
            $query->lockForUpdate();
        }
        $row = $query->first();
        abort_unless($row && $permissions->canInWorkspace('read', (int) $row->branch_id), 404);

        return $row;
    }

    private function impact(object $group, array $change, int $page = 1, string $search = '', ?array $stable = null): array
    {
        $db = DB::connection('tenant');
        $requirements = $db->table('study_group_requirements')->where('group_id', $group->id)
            ->orderBy('number')->get(['id', 'plan_lecture_id', 'number', 'content', 'title', 'retired_at']);
        $active = $requirements->whereNull('retired_at')->values();
        abort_if($active->count() === 0 || $active->count() >= 200 && $change['kind'] === 'add', 422,
            'عدد محاضرات المجموعة خارج النطاق المسموح.');
        $session = null;
        $removedId = null;
        if ($change['kind'] === 'reduce') {
            abort_if($active->count() <= 1, 422, 'لا يمكن خفض العدد إلى صفر.');
            $row = $db->table('study_sessions')->where('id', $change['session_id'])
                ->where('group_id', $group->id)->first();
            abort_unless($row, 404);
            $requirement = $active->firstWhere('id', $row->group_requirement_id);
            abort_unless($requirement, 409, 'متطلب المحاضرة لم يعد معتمدًا.');
            $creditId = $requirement->plan_lecture_id ?? $requirement->id;
            $openSnapshot = $db->table('study_attempt_waitlists as waitlists')
                ->join('study_attempts as attempts', 'attempts.id', '=', 'waitlists.attempt_id')
                ->leftJoin('study_attempt_group_periods as periods', 'periods.id', '=', 'waitlists.origin_period_id')
                ->where('waitlists.from_group_id', $group->id)->whereNull('waitlists.left_on')
                ->where('attempts.status', 'active')
                ->where(fn (Builder $query) => $query->whereNull('periods.required_credit_ids')
                    ->orWhereRaw('periods.required_credit_ids @> ?::jsonb', [json_encode([$creditId])]))->exists();
            if ($openSnapshot) {
                $this->conflict('waitlisted_requirement_snapshot_exists');
            }
            $hasAttendance = $db->table('study_attendance_entries')->where('session_id', $row->id)->exists();
            $hasTeaching = $db->table('study_session_teaching_segments')->where('session_id', $row->id)->exists();
            $hasReplacement = $db->table('study_sessions')->where('replaces_session_id', $row->id)->exists();
            $hasMakeupBooking = $db->table('study_sessions as requirement_sessions')
                ->where('requirement_sessions.group_requirement_id', $requirement->id)
                ->whereExists(fn (Builder $query) => $query->selectRaw('1')
                    ->from('study_makeup_bookings as bookings')
                    ->where(fn (Builder $linked) => $linked
                        ->whereColumn('bookings.session_id', 'requirement_sessions.id')
                        ->orWhereColumn('bookings.source_session_id', 'requirement_sessions.id')))
                ->exists();
            if ($hasMakeupBooking) {
                $this->conflict('makeup_booking_exists');
            }
            if ($hasTeaching) {
                $this->conflict('session_has_teaching');
            }
            if ($row->closed_at !== null || $hasAttendance || $hasReplacement
                || ! in_array($row->status, ['planned', 'cancelled'], true)
                || ($row->status === 'cancelled' && ($row->cancelled_at === null
                    || ! in_array($row->compensation_decision, ['academic', 'financial', 'none'], true)))) {
                $this->conflict('session_not_final_cancellation');
            }
            if ($row->status === 'cancelled' && $row->compensation_decision !== 'academic'
                && $row->compensation_decision !== $change['decision']) {
                $this->conflict('compensation_decision_changed');
            }
            $session = ['id' => $row->id, 'group_requirement_id' => $row->group_requirement_id,
                'status' => $row->status, 'revision' => (int) $row->revision,
                'scheduled_at' => $row->scheduled_at, 'cancelled_at' => $row->cancelled_at,
                'compensation_decision' => $row->compensation_decision];
            $removedId = $requirement->id;
        }
        $beforeCount = $active->count();
        $afterCount = $change['kind'] === 'add' ? $beforeCount + 1 : $beforeCount - 1;
        $lastNumber = (int) $requirements->max('number') + ($change['kind'] === 'add' ? 1 : 0);
        $creditIds = $active->map(fn (object $row): string => $row->plan_lecture_id ?? $row->id)->all();
        $removed = $removedId ? $requirements->firstWhere('id', $removedId) : null;
        $removedCredit = $removed ? ($removed->plan_lecture_id ?? $removed->id) : null;
        $studentQuery = $this->studentImpactQuery($group);
        if ($stable === null) {
            $snapshot = $db->query()->fromSub($studentQuery, 'impact_rows')
                ->selectRaw("count(*) AS total, md5(COALESCE(string_agg(md5(impact_rows.id::text || ':' || impact_rows.completion_threshold::text || ':' || impact_rows.attendance_rows::text || ':' || impact_rows.approvals::text), ',' ORDER BY impact_rows.id), '')) AS fingerprint")
                ->first();
            $total = (int) $snapshot->total;
        } else {
            // CenterWrites serializes center writes while the approved impact rows are persisted.
            $total = $stable['affected_total'];
        }
        $filteredQuery = clone $studentQuery;
        if ($search !== '') {
            $name = mb_strtolower(preg_replace('/\s+/u', ' ', $search));
            $number = str_replace('٬', '', strtr($search,
                array_combine(mb_str_split('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'), str_split('01234567890123456789'))));
            if (ctype_digit($number) && strlen($number) <= 18) {
                $filteredQuery->where('students.student_number', (int) $number);
            } else {
                $filteredQuery->whereRaw('strpos(students.name_search, ?) > 0', [$name]);
            }
        }
        $filteredTotal = $search === '' ? $total
            : (int) $db->query()->fromSub($filteredQuery, 'filtered_impacts')->count();
        $students = (clone $filteredQuery)->orderBy('students.student_number')->orderBy('attempts.id')
            ->offset(($page - 1) * 20)->limit(20)->get()
            ->map(fn (object $row): array => $this->studentImpact($row, $creditIds, $removedCredit,
                $beforeCount, $afterCount))->all();
        $before = ['required_count' => $beforeCount, 'last_number' => (int) $requirements->max('number')];
        $after = ['required_count' => $afterCount, 'last_number' => $lastNumber];
        $token = $stable['preview_token'] ?? hash('sha256', json_encode([$group->id, $group->revision,
            $change, $requirements->toArray(), $session, $total, $snapshot->fingerprint]));

        return ['group_revision' => (int) $group->revision, 'before' => $before, 'after' => $after,
            'session' => $session, 'students' => $students, 'preview_token' => $token,
            'affected_total' => $total,
            'pagination' => ['page' => $page, 'has_more' => $filteredTotal > $page * 20,
                'total' => $filteredTotal]];
    }

    private function studentImpactQuery(object $group): Builder
    {
        return DB::connection('tenant')->table('study_attempts as attempts')
            ->join('students', 'students.id', '=', 'attempts.student_id')
            ->where('attempts.current_group_id', $group->id)
            ->where('attempts.status', 'active')
            ->where('attempts.plan_version_id', $group->plan_version_id)
            ->select(['attempts.id', 'attempts.completion_threshold', 'students.name', 'students.student_number'])
            ->selectRaw(<<<'SQL'
COALESCE((SELECT json_agg(json_build_object('id', COALESCE(sessions.plan_lecture_id, sessions.group_requirement_id),
    'final', sessions.closed_at IS NOT NULL) ORDER BY entries.id)
    FROM study_attendance_entries AS entries
    JOIN study_sessions AS sessions ON sessions.id = entries.session_id
    WHERE entries.attempt_id = attempts.id AND entries.status = 'counted'
      AND sessions.status <> 'cancelled'), '[]'::json) AS attendance_rows,
COALESCE((SELECT json_agg(json_build_object('id', approvals.id,
    'source_lecture_ids', approvals.source_lecture_ids, 'target_lecture_ids', approvals.target_lecture_ids) ORDER BY approvals.id)
    FROM content_equivalences AS approvals
    WHERE approvals.target_plan_version_id = attempts.plan_version_id
      OR EXISTS (SELECT 1 FROM study_attempt_transfers AS transfers
          WHERE transfers.attempt_id = attempts.id
            AND transfers.to_plan_version_id = approvals.target_plan_version_id)
      OR EXISTS (SELECT 1 FROM study_attempt_plan_applications AS applications
          WHERE applications.attempt_id = attempts.id
            AND applications.to_plan_version_id = approvals.target_plan_version_id)), '[]'::json)::jsonb ||
COALESCE((SELECT json_agg(json_build_object('id', mappings.id,
    'source_lecture_ids', json_build_array(mappings.candidate_requirement_id),
    'target_lecture_ids', json_build_array(mappings.required_requirement_id)) ORDER BY mappings.id)
    FROM study_group_requirement_equivalences AS mappings
    WHERE mappings.required_group_id = attempts.current_group_id AND mappings.revoked_at IS NULL), '[]'::json)::jsonb AS approvals
SQL);
    }

    private function studentImpact(object $row, array $creditIds, ?string $removedCredit,
        int $beforeCount, int $afterCount): array
    {
        $credits = StudyCoverageCredits::resolve(
            json_decode($row->attendance_rows, true), json_decode($row->approvals, true))['lectures'];
        $coveredIds = array_intersect($creditIds, array_keys($credits));
        $afterCoveredIds = $removedCredit ? array_diff($coveredIds, [$removedCredit]) : $coveredIds;
        $covered = count($coveredIds);
        $afterCovered = count($afterCoveredIds);
        $beforeFinal = count(array_filter($coveredIds, fn (string $id): bool => $credits[$id] === true));
        $afterFinal = count(array_filter($afterCoveredIds, fn (string $id): bool => $credits[$id] === true));
        $threshold = (int) $row->completion_threshold;
        $beforeEligible = $covered * 100 >= $threshold * $beforeCount;
        $afterEligible = $afterCovered * 100 >= $threshold * $afterCount;

        return ['attempt_id' => $row->id, 'name' => $row->name,
            'student_number' => (int) $row->student_number,
            'completion_threshold' => $threshold,
            'covered_count' => $covered, 'after_covered_count' => $afterCovered,
            'before_open_count' => $covered - $beforeFinal,
            'after_open_count' => $afterCovered - $afterFinal,
            'before_percentage' => round($covered * 100 / $beforeCount, 2),
            'after_percentage' => round($afterCovered * 100 / $afterCount, 2),
            'before_needed' => (int) ceil($threshold * $beforeCount / 100),
            'after_needed' => (int) ceil($threshold * $afterCount / 100),
            'before_eligible' => $beforeEligible, 'after_eligible' => $afterEligible,
            'before_provisional' => $beforeEligible && $beforeFinal * 100 < $threshold * $beforeCount,
            'after_provisional' => $afterEligible && $afterFinal * 100 < $threshold * $afterCount];
    }

    private function persistImpactHistory(object $group, array $impact, string $requestId, Carbon $now): void
    {
        $db = DB::connection('tenant');
        $requirements = $db->table('study_group_requirements')->where('group_id', $group->id)
            ->whereNull('retired_at')->get(['id', 'plan_lecture_id']);
        $creditIds = $requirements->map(fn (object $row): string => $row->plan_lecture_id ?? $row->id)->all();
        $removed = $requirements->firstWhere('id', $impact['session']['group_requirement_id'] ?? null);
        $removedCredit = $removed ? ($removed->plan_lecture_id ?? $removed->id) : null;
        $beforeCount = $impact['before']['required_count'];
        $afterCount = $impact['after']['required_count'];
        $this->studentImpactQuery($group)->chunkById(200, function ($rows) use ($db, $group, $requestId,
            $now, $creditIds, $removedCredit, $beforeCount, $afterCount): void {
            $db->table('study_group_requirement_impacts')->insert(
                $rows->map(fn (object $row): array => $this->studentImpact($row, $creditIds,
                    $removedCredit, $beforeCount, $afterCount))->map(fn (array $student): array => [
                        'request_id' => $requestId, 'group_id' => $group->id,
                        'attempt_id' => $student['attempt_id'],
                        'completion_threshold' => $student['completion_threshold'],
                        'before_covered' => $student['covered_count'],
                        'after_covered' => $student['after_covered_count'],
                        'before_open_count' => $student['before_open_count'],
                        'after_open_count' => $student['after_open_count'],
                        'before_required' => $beforeCount,
                        'after_required' => $afterCount,
                        'before_percentage' => $student['before_percentage'],
                        'after_percentage' => $student['after_percentage'],
                        'before_needed' => $student['before_needed'],
                        'after_needed' => $student['after_needed'],
                        'before_eligible' => $student['before_eligible'],
                        'after_eligible' => $student['after_eligible'],
                        'before_provisional' => $student['before_provisional'],
                        'after_provisional' => $student['after_provisional'],
                        'created_at' => $now,
                    ])->all()
            );
        }, 'attempts.id', 'id');
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
