<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use DateTimeImmutable;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudyTeachingController extends Controller
{
    public function workspace(Request $request, string $groupId, string $sessionId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId) && Str::isUuid($sessionId), 404);
        $permissions = $request->attributes->get('center_permissions');
        $session = $this->session($groupId, $sessionId, $permissions);

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(),
            'session' => $session,
            'can_record' => $this->canRecord($session, $permissions),
        ])->header('Cache-Control', 'private, no-store');
    }

    public function save(Request $request, string $groupId, string $sessionId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId) && Str::isUuid($sessionId), 404);
        $data = $request->validate([
            'revision' => ['required', 'integer', 'min:1'],
            'request_id' => ['required', 'uuid'],
            'segments' => ['present', 'array', 'max:50'],
            'segments.*.instructor_id' => ['required', 'uuid'],
            'segments.*.start_minute' => ['required', 'integer', 'min:0', 'max:719'],
            'segments.*.duration_minutes' => ['required', 'integer', 'min:1', 'max:720'],
            'reason' => ['nullable', 'string', 'max:1000'],
        ]);
        $segments = array_map(fn (array $row): array => [
            'instructor_id' => $row['instructor_id'],
            'start_minute' => (int) $row['start_minute'],
            'duration_minutes' => (int) $row['duration_minutes'],
        ], $data['segments']);
        usort($segments, fn (array $a, array $b): int => [$a['start_minute'], $a['instructor_id'], $a['duration_minutes']]
            <=> [$b['start_minute'], $b['instructor_id'], $b['duration_minutes']]);
        $reason = trim($data['reason'] ?? '') ?: null;
        $hash = hash('sha256', json_encode([$groupId, $sessionId, $segments, $reason], JSON_THROW_ON_ERROR));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $groupId, $sessionId, $data, $segments, $reason, $hash): JsonResponse {
            $session = $this->session($groupId, $sessionId, $permissions, true);
            $db = DB::connection('tenant');
            $previous = $db->table('study_session_teaching_submissions')->where('request_id', $data['request_id'])->first();
            if ($previous !== null) {
                abort_unless($previous->session_id === $sessionId && (int) $previous->actor_id === $request->user()->id, 403);
                if ($previous->request_hash !== $hash) {
                    $this->conflict('teaching_request_changed');
                }

                return response()->json([...json_decode($previous->result, true), 'replayed' => true]);
            }
            abort_unless($this->canRecord($session, $permissions), 403);
            if ((int) $session['teaching_revision'] !== (int) $data['revision']) {
                $this->conflict('teaching_changed');
            }
            abort_if($segments === [] && $session['segments'] === [], 422, 'اختر محاضرًا واحدًا على الأقل.');
            $instructorNames = $this->validateSegments($segments, (int) $session['branch_id']);
            $before = array_map(fn (array $row): array => [
                'instructor_id' => $row['instructor_id'], 'start_minute' => $row['start_minute'],
                'duration_minutes' => $row['duration_minutes'],
            ], $session['segments']);
            usort($before, fn (array $a, array $b): int => [$a['start_minute'], $a['instructor_id'], $a['duration_minutes']]
                <=> [$b['start_minute'], $b['instructor_id'], $b['duration_minutes']]);
            if ($before !== $segments && $before !== [] && ($reason === null || mb_strlen($reason) < 3)) {
                abort(422, 'أدخل سبب تصحيح سجل التدريس من ثلاثة أحرف على الأقل.');
            }
            $revision = (int) $session['teaching_revision'];
            if ($before !== $segments) {
                $db->table('study_session_teaching_segments')->where('session_id', $sessionId)->delete();
                $now = now();
                if ($segments !== []) {
                    $db->table('study_session_teaching_segments')->insert(array_map(
                        fn (array $row): array => [
                            'id' => (string) Str::uuid(), 'session_id' => $sessionId,
                            ...$row, 'recorded_by' => $request->user()->id,
                            'created_at' => $now, 'updated_at' => $now,
                        ], $segments));
                }
                $revision++;
                $db->table('study_sessions')->where('id', $sessionId)->update([
                    'teaching_revision' => $revision, 'updated_at' => $now,
                ]);
                $priorNames = array_column($session['segments'], 'instructor_name', 'instructor_id');
                $db->table('center_audit_logs')->insert([
                    'actor_id' => $request->user()->id, 'branch_id' => $session['branch_id'],
                    'event' => $before === [] ? 'study_session.teaching_recorded' : 'study_session.teaching_corrected',
                    'details' => json_encode([
                        'group_id' => $groupId, 'session_id' => $sessionId,
                        'session_number' => $session['number'],
                        'before' => array_map(fn (array $row): array => [...$row,
                            'instructor_name' => $priorNames[$row['instructor_id']] ?? $row['instructor_id'],
                        ], $before),
                        'after' => array_map(fn (array $row): array => [...$row,
                            'instructor_name' => $instructorNames[$row['instructor_id']] ?? $row['instructor_id'],
                        ], $segments), 'reason' => $reason,
                    ], JSON_THROW_ON_ERROR), 'created_at' => $now,
                ]);
            }
            $current = $this->session($groupId, $sessionId, $permissions);
            $result = ['segments' => $current['segments'], 'revision' => $revision];
            $db->table('study_session_teaching_submissions')->insert([
                'request_id' => $data['request_id'], 'session_id' => $sessionId,
                'actor_id' => $request->user()->id, 'request_hash' => $hash,
                'result' => json_encode($result, JSON_THROW_ON_ERROR), 'created_at' => now(),
            ]);

            return response()->json([...$result, 'replayed' => false], $before === $segments ? 200 : 201);
        })->header('Cache-Control', 'private, no-store');
    }

    private function session(string $groupId, string $sessionId, CenterPermissions $permissions, bool $lock = false): array
    {
        $query = DB::connection('tenant')->table('study_sessions as sessions')
            ->join('study_groups as groups', 'groups.id', '=', 'sessions.group_id')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->where('sessions.id', $sessionId)->where('sessions.group_id', $groupId)
            ->select(['sessions.id', 'sessions.group_id', 'sessions.number', 'sessions.title',
                'sessions.status', 'sessions.scheduled_at', 'sessions.teaching_revision',
                'groups.name as group_name', 'groups.status as group_status',
                'groups.started_at as group_started_at', 'courses.branch_id'])
            ->selectRaw("COALESCE((SELECT jsonb_agg(to_jsonb(suggested) ORDER BY suggested.name, suggested.id) FROM
                (SELECT instructors.id, instructors.name FROM study_group_instructors AS assigned
                 JOIN instructors ON instructors.id = assigned.instructor_id
                 JOIN instructor_branches AS authorized ON authorized.instructor_id = instructors.id
                   AND authorized.branch_id = courses.branch_id
                 WHERE assigned.group_id = groups.id ORDER BY instructors.name, instructors.id LIMIT 50) AS suggested), '[]'::jsonb) AS suggested_instructors")
            ->selectRaw("COALESCE((SELECT jsonb_agg(to_jsonb(teaching) ORDER BY teaching.start_minute, teaching.instructor_id) FROM
                (SELECT segments.id, segments.instructor_id, instructors.name AS instructor_name,
                    segments.start_minute, segments.duration_minutes
                 FROM study_session_teaching_segments AS segments
                 JOIN instructors ON instructors.id = segments.instructor_id
                 WHERE segments.session_id = sessions.id ORDER BY segments.start_minute, segments.instructor_id LIMIT 50) AS teaching), '[]'::jsonb) AS segments");
        if ($lock) {
            $query->lock('FOR UPDATE OF sessions');
        }
        $row = $query->first();
        abort_unless($row && $permissions->can('read', (int) $row->branch_id), 404);

        return [...(array) $row,
            'branch_id' => (int) $row->branch_id,
            'number' => (int) $row->number,
            'teaching_revision' => (int) $row->teaching_revision,
            'suggested_instructors' => json_decode($row->suggested_instructors, true),
            'segments' => json_decode($row->segments, true),
        ];
    }

    private function canRecord(array $session, CenterPermissions $permissions): bool
    {
        return $permissions->can('attendance.record', $session['branch_id'])
            && $session['status'] !== 'cancelled'
            && in_array($session['group_status'], ['started', 'completed'], true)
            && $session['group_started_at'] !== null
            && new DateTimeImmutable($session['group_started_at']) <= new DateTimeImmutable($session['scheduled_at'])
            && new DateTimeImmutable($session['scheduled_at']) <= now()->toImmutable();
    }

    private function validateSegments(array $segments, int $branchId): array
    {
        $ids = array_values(array_unique(array_column($segments, 'instructor_id')));
        $authorized = DB::connection('tenant')->table('instructor_branches')
            ->join('instructors', 'instructors.id', '=', 'instructor_branches.instructor_id')
            ->where('branch_id', $branchId)->whereIn('instructor_id', $ids)
            ->pluck('instructors.name', 'instructor_branches.instructor_id')->all();
        abort_unless(count($authorized) === count($ids), 422, 'اختر محاضرين من الفرع المصرح به فقط.');
        $ends = [];
        foreach ($segments as $segment) {
            $start = $segment['start_minute'];
            $end = $start + $segment['duration_minutes'];
            abort_if($end > 720, 422, 'لا يمكن تجاوز ١٢ ساعة من بداية المحاضرة.');
            $id = $segment['instructor_id'];
            abort_if(isset($ends[$id]) && $start < $ends[$id], 422, 'فترات المحاضر الواحد لا يجوز أن تتداخل.');
            $ends[$id] = $end;
        }

        return $authorized;
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
