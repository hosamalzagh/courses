<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use DateTimeImmutable;
use DateTimeZone;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudyAttendanceController extends Controller
{
    public function workspace(Request $request, string $groupId, string $sessionId): JsonResponse
    {
        $data = $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'entry_id' => ['sometimes', 'uuid'],
            'q' => ['nullable', 'string', 'max:255']]);
        $permissions = $request->attributes->get('center_permissions');
        $session = $this->session($groupId, $sessionId, $permissions, false, $request->user()->id);
        $page = (int) ($data['page'] ?? 1);
        $roster = $this->roster($session);
        if (isset($data['entry_id'])) {
            $roster->where('entries.id', $data['entry_id']);
        }
        if (isset($data['q']) && trim($data['q']) !== '') {
            $search = mb_strtolower(preg_replace('/\s+/u', ' ', trim($data['q'])));
            $number = str_replace('٬', '', strtr(trim($data['q']),
                array_combine(mb_str_split('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'), str_split('01234567890123456789'))));
            $roster->where(function (Builder $query) use ($search, $number): void {
                $query->whereRaw('strpos(students.name_search, ?) > 0', [$search]);
                if (ctype_digit($number) && strlen($number) <= 18) {
                    $query->orWhere('students.student_number', (int) $number);
                }
            });
        }
        $rows = $roster->orderBy('students.student_number')->orderBy('attempts.id')
            ->offset(($page - 1) * 20)->limit(21)->get();

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(),
            'group' => ['id' => $session->group_id, 'name' => $session->group_name, 'branch_id' => $session->branch_id],
            'session' => $session,
            'students' => $rows->take(20)->values(),
            'pagination' => ['page' => $page, 'has_more' => $rows->count() > 20],
            'can_record' => $permissions->can('attendance.record', (int) $session->branch_id),
            'can_correct' => $permissions->can('attendance.correct', (int) $session->branch_id),
            'can_revoke' => $permissions->can('sessions.revoke', (int) $session->branch_id),
            'can_close' => $permissions->can('attendance.close', (int) $session->branch_id),
            'can_undo_own' => $permissions->can('attendance.undo_own', (int) $session->branch_id),
            'last_own_attempt_id' => $session->last_own_attempt_id,
            'has_started' => $session->group_status === 'started'
                && $session->group_started_at !== null
                && new DateTimeImmutable($session->group_started_at) <= new DateTimeImmutable($session->scheduled_at)
                && now()->toImmutable() >= new DateTimeImmutable($session->scheduled_at),
        ])->header('Cache-Control', 'private, no-store');
    }

    public function record(Request $request, string $groupId, string $sessionId): JsonResponse
    {
        $data = $request->validate([
            'attempt_id' => ['required', 'uuid'], 'status' => ['required', 'in:counted,not_counted'],
            'revision' => ['required', 'integer', 'min:1'], 'request_id' => ['required', 'uuid'],
        ]);

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $groupId, $sessionId, $data): JsonResponse {
            $session = $this->session($groupId, $sessionId, $permissions, true);
            abort_unless($permissions->can('attendance.record', (int) $session->branch_id), 403);
            $hash = hash('sha256', json_encode([$sessionId, 'record', $data['attempt_id'], $data['status']]));
            if ($previous = $this->submission($request, $sessionId, $data['request_id'], $hash)) {
                return response()->json(['entry' => json_decode($previous->result_entry), 'revision' => $previous->result_revision]);
            }
            $this->open($session, (int) $data['revision']);
            $eligible = $this->roster($session)->where('attempts.id', $data['attempt_id'])->first();
            abort_unless($eligible, 404);
            $sessionDate = (new DateTimeImmutable($session->scheduled_at))
                ->setTimezone(new DateTimeZone('Africa/Cairo'))->format('Y-m-d');
            abort_if($eligible->attempt_status === 'withdrawn'
                && ($eligible->withdrawn_on === null || $eligible->withdrawn_on <= $sessionDate), 409,
                'سُحبت محاولة الطالب قبل تسجيل الحضور.');
            if ($eligible->student_status === 'suspended' || $eligible->suspended_at !== null) {
                $this->conflict('student_suspended_for_session');
            }
            abort_if($eligible->status !== null, 409, 'سجل الحضور تغير؛ حمّل أحدث البيانات.');
            $now = now();
            $entryId = $eligible->entry_id ?? (string) Str::uuid();
            if ($eligible->entry_id) {
                DB::connection('tenant')->table('study_attendance_entries')->where('id', $entryId)->update([
                    'status' => $data['status'], 'revision' => $eligible->entry_revision + 1,
                    'recorded_by' => $request->user()->id, 'recorded_at' => $now, 'updated_at' => $now,
                ]);
            } else {
                DB::connection('tenant')->table('study_attendance_entries')->insert([
                    'id' => $entryId, 'session_id' => $sessionId, 'attempt_id' => $data['attempt_id'],
                    'status' => $data['status'], 'revision' => 1, 'recorded_by' => $request->user()->id,
                    'recorded_at' => $now, 'created_at' => $now, 'updated_at' => $now,
                ]);
            }
            $this->event($sessionId, $data['attempt_id'], 'record', null, $data['status'], $request->user()->id, $session->revision + 1);
            $this->advance($sessionId, $session->revision + 1);
            $entry = DB::connection('tenant')->table('study_attendance_entries')->where('id', $entryId)->first();
            $this->saveSubmission($data['request_id'], $sessionId, 'record', $hash, $request->user()->id, $entryId, $session->revision + 1, $entry);
            $this->audit($request->user()->id, (int) $session->branch_id, 'study_attendance.recorded', [
                'group_id' => $groupId, 'session_id' => $sessionId, 'attempt_id' => $data['attempt_id'],
                'before' => null, 'after' => $data['status'],
            ]);

            return response()->json(['entry' => $entry, 'revision' => $session->revision + 1], 201);
        });
    }

    public function undo(Request $request, string $groupId, string $sessionId, string $entryId): JsonResponse
    {
        abort_unless(Str::isUuid($entryId), 404);
        $data = $request->validate(['revision' => ['required', 'integer', 'min:1'], 'request_id' => ['required', 'uuid']]);

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $groupId, $sessionId, $entryId, $data): JsonResponse {
            $session = $this->session($groupId, $sessionId, $permissions, true);
            abort_unless($permissions->can('attendance.undo_own', (int) $session->branch_id), 403);
            $hash = hash('sha256', json_encode([$sessionId, 'undo', $entryId]));
            if ($previous = $this->submission($request, $sessionId, $data['request_id'], $hash)) {
                return response()->json(['entry' => json_decode($previous->result_entry), 'revision' => $previous->result_revision]);
            }
            $this->open($session, (int) $data['revision']);
            $entry = DB::connection('tenant')->table('study_attendance_entries')->where('id', $entryId)->where('session_id', $sessionId)->lockForUpdate()->first();
            abort_unless($entry, 404);
            $last = DB::connection('tenant')->table('study_attendance_events')->where('session_id', $sessionId)
                ->where('actor_id', $request->user()->id)->orderByDesc('session_revision')->first();
            abort_unless($entry->recorded_by === $request->user()->id && in_array($entry->status, ['counted', 'not_counted'], true)
                && $last?->kind === 'record' && $last->attempt_id === $entry->attempt_id, 409, 'يمكن التراجع عن آخر إدخال لك فقط في محاضرة مفتوحة.');
            $now = now();
            DB::connection('tenant')->table('study_attendance_entries')->where('id', $entryId)->update([
                'status' => null, 'revision' => $entry->revision + 1, 'recorded_by' => null,
                'recorded_at' => null, 'updated_at' => $now,
            ]);
            $this->event($sessionId, $entry->attempt_id, 'undo', $entry->status, null, $request->user()->id, $session->revision + 1);
            $this->advance($sessionId, $session->revision + 1);
            $undoneEntry = DB::connection('tenant')->table('study_attendance_entries')->where('id', $entryId)->first();
            $this->saveSubmission($data['request_id'], $sessionId, 'undo', $hash, $request->user()->id, $entryId, $session->revision + 1, $undoneEntry);
            $this->audit($request->user()->id, (int) $session->branch_id, 'study_attendance.undone', [
                'group_id' => $groupId, 'session_id' => $sessionId, 'attempt_id' => $entry->attempt_id,
                'before' => $entry->status, 'after' => null,
            ]);

            return response()->json(['entry' => $undoneEntry, 'revision' => $session->revision + 1]);
        });
    }

    public function close(Request $request, string $groupId, string $sessionId): JsonResponse
    {
        $data = $request->validate(['revision' => ['required', 'integer', 'min:1'], 'request_id' => ['required', 'uuid']]);

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $groupId, $sessionId, $data): JsonResponse {
            $session = $this->session($groupId, $sessionId, $permissions, true);
            abort_unless($permissions->can('attendance.close', (int) $session->branch_id), 403);
            $hash = hash('sha256', json_encode([$sessionId, 'close']));
            if ($this->submission($request, $sessionId, $data['request_id'], $hash)) {
                return response()->json(['session' => $session, 'absent_count' => DB::connection('tenant')->table('study_attendance_entries')
                    ->where('session_id', $sessionId)->where('status', 'absent')->count()]);
            }
            $this->open($session, (int) $data['revision']);
            $date = (new DateTimeImmutable($session->scheduled_at))->setTimezone(new DateTimeZone('Africa/Cairo'))->format('Y-m-d');
            $pending = $this->roster($session)->whereNull('entries.status')
                ->whereExists(function ($query) use ($session, $date): void {
                    $query->selectRaw('1')->from('study_attempt_group_periods as regular_periods')
                        ->whereColumn('regular_periods.attempt_id', 'attempts.id')
                        ->where('regular_periods.group_id', $session->group_id)
                        ->where('regular_periods.joined_on', '<=', $date)
                        ->where(fn ($period) => $period->whereNull('regular_periods.left_on')->orWhere('regular_periods.left_on', '>', $date));
                })
                ->addSelect('session_suspensions.id as suspension_id')->get();
            $unrecorded = $pending->filter(fn ($student) => $student->suspension_id === null);
            $suspended = $pending->filter(fn ($student) => $student->suspension_id !== null);
            $now = now();
            foreach ($unrecorded->pluck('entry_id')->filter()->chunk(500) as $ids) {
                DB::connection('tenant')->table('study_attendance_entries')->whereIn('id', $ids->all())
                    ->whereNull('status')->update(['status' => 'absent', 'revision' => DB::raw('revision + 1'),
                        'recorded_by' => $request->user()->id, 'recorded_at' => $now, 'updated_at' => $now]);
            }
            $newEntries = $unrecorded->filter(fn ($student) => $student->entry_id === null)->map(fn ($student): array => [
                'id' => (string) Str::uuid(), 'session_id' => $sessionId, 'attempt_id' => $student->attempt_id,
                'status' => 'absent', 'revision' => 1, 'recorded_by' => $request->user()->id,
                'recorded_at' => $now, 'created_at' => $now, 'updated_at' => $now,
            ]);
            foreach ($newEntries->values()->chunk(500) as $entries) {
                DB::connection('tenant')->table('study_attendance_entries')->insert($entries->all());
            }
            foreach ($suspended->filter(fn ($student) => $student->entry_id === null)->values()->chunk(500) as $students) {
                DB::connection('tenant')->table('study_attendance_entries')->insert($students->map(fn ($student): array => [
                    'id' => (string) Str::uuid(), 'session_id' => $sessionId, 'attempt_id' => $student->attempt_id,
                    'status' => null, 'revision' => 1, 'recorded_by' => null, 'recorded_at' => null,
                    'created_at' => $now, 'updated_at' => $now,
                ])->all());
            }
            DB::connection('tenant')->table('study_sessions')->where('id', $sessionId)->update([
                'status' => 'held', 'closed_at' => $now, 'closed_by' => $request->user()->id,
                'revision' => $session->revision + 1, 'updated_at' => $now,
            ]);
            $this->event($sessionId, null, 'close', null, null, $request->user()->id, $session->revision + 1);
            $this->saveSubmission($data['request_id'], $sessionId, 'close', $hash, $request->user()->id, null, $session->revision + 1, null);
            $this->audit($request->user()->id, (int) $session->branch_id, 'study_attendance.closed', [
                'group_id' => $groupId, 'session_id' => $sessionId,
                'absent_count' => $unrecorded->count(),
                'suspended_count' => $suspended->count(),
                'absent_attempt_ids' => $unrecorded->take(20)->pluck('attempt_id')->all(),
            ]);

            return response()->json(['session' => ['id' => $sessionId, 'status' => 'held', 'closed_at' => $now,
                'revision' => $session->revision + 1], 'absent_count' => $unrecorded->count()]);
        });
    }

    public function correct(Request $request, string $groupId, string $sessionId, string $entryId): JsonResponse
    {
        abort_unless(Str::isUuid($entryId), 404);
        $data = $request->validate([
            'status' => ['required', 'in:counted,not_counted,absent'],
            'reason' => ['required', 'string', 'min:3', 'max:1000'],
            'revision' => ['required', 'integer', 'min:1'],
            'entry_revision' => ['required', 'integer', 'min:1'],
            'request_id' => ['required', 'uuid'],
        ]);

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $groupId, $sessionId, $entryId, $data): JsonResponse {
            $session = $this->session($groupId, $sessionId, $permissions, true);
            abort_unless($permissions->can('attendance.correct', (int) $session->branch_id), 403);
            $reason = trim($data['reason']);
            abort_if(mb_strlen($reason) < 3, 422, 'سبب التصحيح مطلوب.');
            $hash = hash('sha256', json_encode([$sessionId, 'correct', $entryId, $data['status'], $reason]));
            if ($previous = $this->submission($request, $sessionId, $data['request_id'], $hash)) {
                return response()->json(['entry' => json_decode($previous->result_entry), 'revision' => $previous->result_revision]);
            }
            if ($session->status !== 'held' || ! $session->closed_at || (int) $session->revision !== (int) $data['revision']) {
                $this->conflict('session_changed');
            }
            $entry = DB::connection('tenant')->table('study_attendance_entries')->where('id', $entryId)
                ->where('session_id', $sessionId)->lockForUpdate()->first();
            abort_unless($entry, 404);
            if ((int) $entry->revision !== (int) $data['entry_revision'] || $entry->status === null || $entry->status === $data['status']) {
                $this->conflict('attendance_changed');
            }
            $now = now();
            DB::connection('tenant')->table('study_attendance_entries')->where('id', $entryId)->update([
                'status' => $data['status'], 'revision' => $entry->revision + 1,
                'recorded_by' => $request->user()->id, 'recorded_at' => $now, 'updated_at' => $now,
            ]);
            $this->event($sessionId, $entry->attempt_id, 'correct', $entry->status, $data['status'],
                $request->user()->id, $session->revision + 1, $reason);
            $this->advance($sessionId, $session->revision + 1);
            $corrected = DB::connection('tenant')->table('study_attendance_entries')->where('id', $entryId)->first();
            $this->saveSubmission($data['request_id'], $sessionId, 'correct', $hash, $request->user()->id,
                $entryId, $session->revision + 1, $corrected);
            $this->audit($request->user()->id, (int) $session->branch_id, 'study_attendance.corrected', [
                'group_id' => $groupId, 'session_id' => $sessionId, 'entry_id' => $entryId,
                'attempt_id' => $entry->attempt_id, 'before' => $entry->status, 'after' => $data['status'],
                'reason' => $reason,
            ]);

            return response()->json(['entry' => $corrected, 'revision' => $session->revision + 1]);
        });
    }

    public function revokePreview(Request $request, string $groupId, string $sessionId): JsonResponse
    {
        $permissions = $request->attributes->get('center_permissions');
        $session = $this->session($groupId, $sessionId, $permissions);
        abort_unless($permissions->can('sessions.revoke', (int) $session->branch_id), 403);
        abort_unless($session->status === 'held' && $session->closed_at, 409, 'المحاضرة ليست معتمدة حاليًا.');

        return response()->json($this->revokeImpact($session))->header('Cache-Control', 'private, no-store');
    }

    public function revoke(Request $request, string $groupId, string $sessionId): JsonResponse
    {
        $data = $request->validate([
            'reason' => ['required', 'string', 'min:3', 'max:1000'],
            'session_revision' => ['required', 'integer', 'min:1'],
            'group_revision' => ['required', 'integer', 'min:1'],
            'preview_token' => ['required', 'string', 'size:64'],
            'request_id' => ['required', 'uuid'],
        ]);

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $groupId, $sessionId, $data): JsonResponse {
            $session = $this->session($groupId, $sessionId, $permissions, true);
            abort_unless($permissions->can('sessions.revoke', (int) $session->branch_id), 403);
            $reason = trim($data['reason']);
            abort_if(mb_strlen($reason) < 3, 422, 'سبب إلغاء الاعتماد مطلوب.');
            $hash = hash('sha256', json_encode([$sessionId, 'revoke', $reason, $data['preview_token']]));
            $previous = DB::connection('tenant')->table('study_session_submissions')->where('request_id', $data['request_id'])->first();
            if ($previous) {
                abort_unless($previous->group_id === $groupId && $previous->actor_id === $request->user()->id, 403);
                if ($previous->request_hash !== $hash || $previous->kind !== 'revoke') {
                    $this->conflict('session_request_changed');
                }

                return response()->json(['session' => $session, 'impact' => json_decode($previous->session_ids, true)]);
            }
            if ($session->status !== 'held' || ! $session->closed_at || (int) $session->revision !== (int) $data['session_revision']
                || (int) $session->group_revision !== (int) $data['group_revision']) {
                $this->conflict('session_changed');
            }
            // CenterWrites holds the center row lock until commit, serializing attendance writes across groups.
            $impact = $this->revokeImpact($session);
            if (! hash_equals($impact['preview_token'], $data['preview_token'])) {
                $this->conflict('revoke_preview_changed');
            }
            $now = now();
            DB::connection('tenant')->table('study_sessions')->where('id', $sessionId)->update([
                'status' => 'cancelled', 'revision' => $session->revision + 1,
                'revoked_at' => $now, 'revoked_by' => $request->user()->id,
                'revoke_reason' => $reason, 'updated_at' => $now,
            ]);
            DB::connection('tenant')->table('study_groups')->where('id', $groupId)->update([
                'revision' => $session->group_revision + 1, 'updated_at' => $now,
            ]);
            DB::connection('tenant')->table('study_session_submissions')->insert([
                'request_id' => $data['request_id'], 'group_id' => $groupId, 'kind' => 'revoke',
                'request_hash' => $hash, 'actor_id' => $request->user()->id,
                'session_ids' => json_encode($impact), 'created_at' => $now,
            ]);
            $this->audit($request->user()->id, (int) $session->branch_id, 'study_session.revoked', [
                'group_id' => $groupId, 'session_id' => $sessionId, 'reason' => $reason,
                'before' => 'held', 'after' => 'cancelled', 'impact' => $impact,
            ]);

            return response()->json(['session' => ['id' => $sessionId, 'status' => 'cancelled',
                'revision' => $session->revision + 1, 'closed_at' => $session->closed_at,
                'revoked_at' => $now], 'impact' => $impact]);
        });
    }

    private function revokeImpact(object $session): array
    {
        $stats = DB::connection('tenant')->table('study_attendance_entries as entries')
            ->leftJoin('study_attempts as attempts', 'attempts.id', '=', 'entries.attempt_id')
            ->where('entries.session_id', $session->id)
            ->selectRaw("COUNT(*) FILTER (WHERE entries.status IS NOT NULL) AS total,
                COUNT(*) FILTER (WHERE entries.status = 'counted') AS counted,
                COUNT(*) FILTER (WHERE entries.status = 'not_counted') AS not_counted,
                COUNT(*) FILTER (WHERE entries.status = 'absent') AS absent,
                COUNT(*) FILTER (WHERE entries.status = 'counted') AS potential_coverage_records,
                COALESCE(bit_xor(hashtextextended(entries.id::text || ':' || entries.revision::text || ':' || COALESCE(entries.status, '') || ':' || COALESCE(attempts.current_group_id::text, '') || ':' || COALESCE(attempts.plan_version_id::text, ''), 0)), 0) AS snapshot")->first();
        $counts = ['total' => (int) $stats->total, 'counted' => (int) $stats->counted,
            'not_counted' => (int) $stats->not_counted, 'absent' => (int) $stats->absent,
            'potential_coverage_records' => (int) $stats->potential_coverage_records];

        return ['session_revision' => (int) $session->revision, 'group_revision' => (int) $session->group_revision,
            'attendance' => $counts,
            'preview_token' => hash('sha256', json_encode([$session->id, $session->revision,
                $session->group_revision, $stats->snapshot, $counts]))];
    }

    private function session(string $groupId, string $sessionId, CenterPermissions $permissions, bool $lock = false, ?int $actorId = null): object
    {
        abort_unless(Str::isUuid($groupId) && Str::isUuid($sessionId), 404);
        $query = DB::connection('tenant')->table('study_sessions as sessions')
            ->join('study_groups as groups', 'groups.id', '=', 'sessions.group_id')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->where('sessions.id', $sessionId)->where('groups.id', $groupId)
            ->select(['sessions.id', 'sessions.group_id', 'sessions.number', 'sessions.title', 'sessions.scheduled_at',
                'sessions.status', 'sessions.revision', 'sessions.closed_at', 'sessions.closed_by',
                'sessions.revoked_at', 'sessions.revoked_by', 'sessions.revoke_reason', 'sessions.plan_lecture_id',
                'groups.name as group_name', 'groups.status as group_status',
                'groups.started_at as group_started_at', 'groups.revision as group_revision',
                'groups.plan_version_id', 'courses.branch_id']);
        if ($actorId !== null) {
            $query->selectSub(DB::connection('tenant')->table('study_attendance_events as own_events')
                ->whereColumn('own_events.session_id', 'sessions.id')->where('own_events.actor_id', $actorId)
                ->orderByDesc('own_events.session_revision')->limit(1)
                ->selectRaw("CASE WHEN own_events.kind = 'record' THEN own_events.attempt_id ELSE NULL END"), 'last_own_attempt_id');
        }
        if ($lock) {
            $query->lockForUpdate();
        }
        $session = $query->first();
        abort_unless($session && $permissions->can('read', (int) $session->branch_id), 404);

        return $session;
    }

    private function roster(object $session): Builder
    {
        $date = (new DateTimeImmutable($session->scheduled_at))->setTimezone(new DateTimeZone('Africa/Cairo'))->format('Y-m-d');

        $roster = DB::connection('tenant')->table('study_attempts as attempts')
            ->join('students', 'students.id', '=', 'attempts.student_id')
            ->leftJoin('study_attempt_withdrawals as withdrawals', 'withdrawals.attempt_id', '=', 'attempts.id')
            ->leftJoin('study_attendance_entries as entries', function ($join) use ($session): void {
                $join->on('entries.attempt_id', '=', 'attempts.id')->where('entries.session_id', $session->id);
            })
            ->leftJoin('study_makeup_bookings as bookings', function ($join) use ($session): void {
                $join->on('bookings.attempt_id', '=', 'attempts.id')->where('bookings.session_id', $session->id);
            })
            ->leftJoin('student_suspensions as session_suspensions', function ($join) use ($session): void {
                $join->on('session_suspensions.student_id', '=', 'students.id')
                    ->where('session_suspensions.suspended_at', '<=', $session->scheduled_at)
                    ->where(fn ($period) => $period->whereNull('session_suspensions.lifted_at')
                        ->orWhere('session_suspensions.lifted_at', '>', $session->scheduled_at));
            })
            ->leftJoin('student_event_notes as attendance_notes', function ($join) use ($session): void {
                $join->on('attendance_notes.event_id', '=', 'entries.id')
                    ->on('attendance_notes.student_id', '=', 'students.id')
                    ->where('attendance_notes.branch_id', $session->branch_id)
                    ->whereNotNull('entries.status')
                    ->whereRaw("attendance_notes.event_type = 'attendance:' || entries.revision::text");
            })
            ->select(['attempts.id as attempt_id', 'attempts.status as attempt_status',
                'withdrawals.withdrawn_on',
                'students.id as student_id', 'students.name', 'students.student_number',
                'students.status as student_status', 'entries.id as entry_id', 'entries.status',
                'entries.revision as entry_revision', 'entries.recorded_by',
                'bookings.id as booking_id',
                'session_suspensions.suspended_at', 'session_suspensions.lifted_at',
                'attendance_notes.body as note_body', 'attendance_notes.important as note_important']);
        if ($session->closed_at) {
            return $roster->where(fn (Builder $query) => $query->whereNotNull('entries.id')
                ->orWhere(fn (Builder $booked) => $booked->whereNotNull('bookings.id')
                    ->where(fn (Builder $active) => $active->where('attempts.status', '<>', 'withdrawn')
                        ->orWhere('withdrawals.withdrawn_on', '>', $date))));
        }

        return $roster->where(function (Builder $query) use ($session, $date): void {
            $query->where(fn (Builder $booked) => $booked->whereNotNull('bookings.id')
                ->where(fn (Builder $active) => $active->where('attempts.status', '<>', 'withdrawn')
                    ->orWhere('withdrawals.withdrawn_on', '>', $date)))
                ->orWhereExists(function ($periods) use ($session, $date): void {
                    $periods->selectRaw('1')->from('study_attempt_group_periods as periods')
                        ->whereColumn('periods.attempt_id', 'attempts.id')->where('periods.group_id', $session->group_id)
                        ->where('periods.joined_on', '<=', $date)
                        ->where(fn ($period) => $period->whereNull('periods.left_on')->orWhere('periods.left_on', '>', $date));
                });
        });
    }

    private function open(object $session, int $revision): void
    {
        if ($session->group_status !== 'started' || $session->group_started_at === null
            || new DateTimeImmutable($session->group_started_at) > new DateTimeImmutable($session->scheduled_at)
            || $session->status === 'cancelled' || $session->closed_at || (int) $session->revision !== $revision
            || new DateTimeImmutable($session->scheduled_at) > now()->toImmutable()) {
            $this->conflict('session_changed');
        }
    }

    private function submission(Request $request, string $sessionId, string $requestId, string $hash): ?object
    {
        $previous = DB::connection('tenant')->table('study_attendance_submissions')->where('request_id', $requestId)->first();
        if ($previous) {
            abort_unless($previous->session_id === $sessionId && $previous->actor_id === $request->user()->id, 403);
            if ($previous->request_hash !== $hash) {
                $this->conflict('attendance_request_changed');
            }
        }

        return $previous;
    }

    private function saveSubmission(string $requestId, string $sessionId, string $kind, string $hash, int $actorId, ?string $entryId, int $resultRevision, ?object $resultEntry): void
    {
        DB::connection('tenant')->table('study_attendance_submissions')->insert([
            'request_id' => $requestId, 'session_id' => $sessionId, 'kind' => $kind, 'request_hash' => $hash,
            'actor_id' => $actorId, 'entry_id' => $entryId, 'result_revision' => $resultRevision,
            'result_entry' => $resultEntry === null ? null : json_encode($resultEntry), 'created_at' => now(),
        ]);
    }

    private function event(string $sessionId, ?string $attemptId, string $kind, ?string $before, ?string $after, int $actorId, int $revision, ?string $reason = null): void
    {
        DB::connection('tenant')->table('study_attendance_events')->insert([
            'id' => (string) Str::uuid(), 'session_id' => $sessionId, 'attempt_id' => $attemptId,
            'kind' => $kind, 'session_revision' => $revision, 'before_status' => $before,
            'after_status' => $after, 'actor_id' => $actorId, 'reason' => $reason, 'created_at' => now(),
        ]);
    }

    private function advance(string $sessionId, int $revision): void
    {
        DB::connection('tenant')->table('study_sessions')->where('id', $sessionId)->update(['revision' => $revision, 'updated_at' => now()]);
    }

    private function audit(int $actorId, int $branchId, string $event, array $details): void
    {
        DB::connection('tenant')->table('center_audit_logs')->insert([
            'actor_id' => $actorId, 'branch_id' => $branchId, 'event' => $event,
            'details' => json_encode($details), 'created_at' => now(),
        ]);
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
