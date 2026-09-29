<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\StudentPhotos;
use App\Support\StudyCoverageCredits;
use DateTimeImmutable;
use DateTimeZone;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudyMakeupController extends Controller
{
    public function workspace(Request $request, string $studentId, string $attemptId): JsonResponse
    {
        $data = $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'q' => ['nullable', 'string', 'max:255']]);
        $permissions = $request->attributes->get('center_permissions');
        $attempt = $this->attempt($studentId, $attemptId, $permissions);
        $page = (int) ($data['page'] ?? 1);
        $branches = $this->branches($permissions, 'read');
        $search = trim($data['q'] ?? '');
        $sessions = DB::connection('tenant')->table('study_sessions as sessions')
            ->join('study_groups as groups', 'groups.id', '=', 'sessions.group_id')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->leftJoin('study_makeup_bookings as bookings', function ($join) use ($attemptId): void {
                $join->on('bookings.session_id', '=', 'sessions.id')->where('bookings.attempt_id', $attemptId);
            })
            ->leftJoin('study_attendance_entries as entries', function ($join) use ($attemptId): void {
                $join->on('entries.session_id', '=', 'sessions.id')->where('entries.attempt_id', $attemptId);
            })
            ->leftJoin('study_sessions as source_sessions', 'source_sessions.id', '=', 'bookings.source_session_id')
            ->leftJoin('study_groups as source_groups', 'source_groups.id', '=', 'source_sessions.group_id')
            ->leftJoin('levels as source_levels', 'source_levels.id', '=', 'source_groups.level_id')
            ->leftJoin('stages as source_stages', 'source_stages.id', '=', 'source_levels.stage_id')
            ->leftJoin('courses as source_courses', 'source_courses.id', '=', 'source_stages.course_id')
            ->whereRaw("(sessions.scheduled_at AT TIME ZONE 'Africa/Cairo')::date >= ?", [$attempt->joined_on])
            ->where(function ($query) use ($attemptId): void {
                $query->whereNotExists(DB::connection('tenant')->table('study_attempt_group_periods as periods')
                    ->where('periods.attempt_id', $attemptId)
                    ->whereColumn('periods.group_id', 'sessions.group_id')
                    ->whereRaw("periods.joined_on <= (sessions.scheduled_at AT TIME ZONE 'Africa/Cairo')::date")
                    ->where(fn ($period) => $period->whereNull('periods.left_on')
                        ->orWhereRaw("periods.left_on > (sessions.scheduled_at AT TIME ZONE 'Africa/Cairo')::date"))
                    ->selectRaw('1'))
                    ->orWhereNotNull('bookings.id');
            })
            ->where(fn ($query) => $query->whereIn('sessions.status', ['planned', 'held'])->orWhereNotNull('bookings.id'))
            ->when($search !== '', fn ($query) => $query->where(function ($matches) use ($search): void {
                $matches->where('groups.name', 'ilike', '%'.$search.'%')
                    ->orWhere('sessions.title', 'ilike', '%'.$search.'%')
                    ->orWhereRaw('sessions.number::text LIKE ?', ['%'.$search.'%']);
            }))
            ->when(! $permissions->isCenterManager(), fn ($query) => $query->whereIn('courses.branch_id', $branches))
            ->select(['sessions.id', 'sessions.group_id', 'sessions.number', 'sessions.title', 'sessions.scheduled_at',
                'sessions.status', 'sessions.revision', 'sessions.plan_lecture_id', 'groups.name as group_name',
                'groups.plan_version_id', 'courses.branch_id', 'bookings.id as booking_id',
                'bookings.source_session_id', 'bookings.booked_at', 'bookings.proved_at',
                'entries.status as attendance_status', 'source_courses.branch_id as source_branch_id',
                'source_groups.name as source_group_name', 'source_sessions.number as source_number',
                'source_sessions.scheduled_at as source_scheduled_at'])
            ->orderByRaw('CASE WHEN bookings.id IS NULL THEN 1 ELSE 0 END')
            ->orderByDesc('sessions.scheduled_at')->orderBy('sessions.id')
            ->offset(($page - 1) * 20)->limit(21)->get();

        return response()->json(['attempt' => $attempt,
            'sessions' => $sessions->take(20)->map(function ($session) use ($attempt, $permissions): array {
                $canReadSource = $session->source_branch_id !== null
                    && $permissions->can('read', (int) $session->source_branch_id);

                return [
                    ...array_diff_key((array) $session, ['source_branch_id' => true,
                        'source_group_name' => true, 'source_number' => true, 'source_scheduled_at' => true]),
                    'source_session_id' => $canReadSource ? $session->source_session_id : null,
                    'booked_source' => $canReadSource && $session->source_session_id !== null ? [
                        'id' => $session->source_session_id, 'group_name' => $session->source_group_name,
                        'number' => $session->source_number, 'scheduled_at' => $session->source_scheduled_at,
                        'branch_id' => $session->source_branch_id,
                    ] : null,
                    'can_book' => $attempt->status !== 'withdrawn' && $attempt->student_status === 'active'
                        && $permissions->can('attendance.record', (int) $session->branch_id)
                        && new DateTimeImmutable($session->scheduled_at) > now()->toImmutable(),
                    'can_prove' => $attempt->student_status === 'active'
                        && ($session->source_session_id === null || $canReadSource)
                        && ($attempt->withdrawn_on === null || $attempt->withdrawn_on > (new DateTimeImmutable($session->scheduled_at))
                            ->setTimezone(new DateTimeZone('Africa/Cairo'))->format('Y-m-d'))
                        && $permissions->can('attendance.correct', (int) $session->branch_id),
                ];
            })->values(),
            'pagination' => ['page' => $page, 'has_more' => $sessions->count() > 20]])
            ->header('Cache-Control', 'private, no-store');
    }

    public function absences(Request $request, string $studentId, string $attemptId): JsonResponse
    {
        $data = $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $permissions = $request->attributes->get('center_permissions');
        $this->attempt($studentId, $attemptId, $permissions);
        $branches = $this->branches($permissions, 'read');
        $page = (int) ($data['page'] ?? 1);
        $rows = DB::connection('tenant')->table('study_attendance_entries as entries')
            ->join('study_sessions as sessions', 'sessions.id', '=', 'entries.session_id')
            ->join('study_groups as groups', 'groups.id', '=', 'sessions.group_id')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->where('entries.attempt_id', $attemptId)->where('entries.status', 'absent')
            ->where('sessions.status', '<>', 'cancelled')
            ->when(! $permissions->isCenterManager(), fn ($query) => $query->whereIn('courses.branch_id', $branches))
            ->orderByDesc('sessions.scheduled_at')->orderBy('sessions.id')
            ->offset(($page - 1) * 20)->limit(21)
            ->get(['sessions.id', 'sessions.number', 'sessions.scheduled_at', 'groups.name as group_name', 'courses.branch_id']);

        return response()->json(['source_absences' => $rows->take(20)->values(),
            'pagination' => ['page' => $page, 'has_more' => $rows->count() > 20]])
            ->header('Cache-Control', 'private, no-store');
    }

    public function book(Request $request, string $studentId, string $attemptId): JsonResponse
    {
        $data = $request->validate(['session_id' => ['required', 'uuid'], 'source_session_id' => ['nullable', 'uuid'],
            'attempt_revision' => ['required', 'integer', 'min:1'], 'session_revision' => ['required', 'integer', 'min:1'],
            'request_id' => ['required', 'uuid']]);
        $hash = hash('sha256', json_encode([$attemptId, $data['session_id'], $data['source_session_id'] ?? null,
            $data['attempt_revision'], $data['session_revision']]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $attemptId, $data, $hash): JsonResponse {
            $attempt = $this->attempt($studentId, $attemptId, $permissions, true);
            $session = $this->session($data['session_id'], $permissions, 'attendance.record');
            if ($prior = DB::connection('tenant')->table('study_makeup_bookings')->where('request_id', $data['request_id'])->first()) {
                abort_unless($prior->attempt_id === $attemptId && $prior->session_id === $session->id
                    && (int) $prior->booked_by === (int) $request->user()->id, 404);
                abort_unless($prior->request_hash === $hash, 409, 'طلب الحجز تغير؛ حمّل أحدث البيانات.');
                if ($prior->source_session_id) {
                    $this->sourceAbsence($attemptId, $prior->source_session_id, $permissions, false);
                }

                return response()->json(['booking' => $prior, 'replayed' => true]);
            }
            $this->validAttempt($attempt, $data['attempt_revision']);
            abort_if($session->status !== 'planned' || $session->closed_at
                || new DateTimeImmutable($session->scheduled_at) <= now()->toImmutable()
                || (int) $session->revision !== $data['session_revision'], 409, 'تغيرت المحاضرة أو بدأ موعدها؛ حمّل أحدث البيانات.');
            $this->eligible($attempt, $session, $permissions, $data['source_session_id'] ?? null);
            abort_if(DB::connection('tenant')->table('study_makeup_bookings')->where('attempt_id', $attemptId)
                ->where('session_id', $session->id)->exists(), 409, 'حُجز هذا التعويض سابقًا.');
            $now = now();
            $booking = ['id' => (string) Str::uuid(), 'attempt_id' => $attemptId, 'session_id' => $session->id,
                'source_session_id' => $data['source_session_id'] ?? null, 'booked_by' => $request->user()->id,
                'booked_at' => $now, 'request_id' => $data['request_id'], 'request_hash' => $hash,
                'created_at' => $now, 'updated_at' => $now];
            DB::connection('tenant')->table('study_makeup_bookings')->insert($booking);
            $this->audit($request->user()->id, (int) $session->branch_id, 'study_makeup.booked', [
                'attempt_id' => $attemptId, 'student_id' => $studentId, 'group_id' => $session->group_id,
                'session_id' => $session->id,
                'booking_id' => $booking['id']]);

            return response()->json(['booking' => $booking], 201);
        });
    }

    public function prove(Request $request, string $studentId, string $attemptId): JsonResponse
    {
        $data = $request->validate(['session_id' => ['required', 'uuid'], 'source_session_id' => ['nullable', 'uuid'],
            'attempt_revision' => ['required', 'integer', 'min:1'], 'session_revision' => ['required', 'integer', 'min:1'],
            'reason' => ['required', 'string', 'min:3', 'max:1000'], 'request_id' => ['required', 'uuid']]);
        $reason = trim($data['reason']);
        abort_if(mb_strlen($reason) < 3, 422, 'سبب إثبات التعويض مطلوب.');
        $hash = hash('sha256', json_encode([$attemptId, $data['session_id'], $data['source_session_id'] ?? null,
            $data['attempt_revision'], $data['session_revision'], $reason]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $attemptId, $data, $reason, $hash): JsonResponse {
            $attempt = $this->attempt($studentId, $attemptId, $permissions, true);
            $session = $this->session($data['session_id'], $permissions, 'attendance.correct');
            $prior = DB::connection('tenant')->table('study_makeup_bookings')->where('proof_request_id', $data['request_id'])->first();
            if ($prior) {
                abort_unless($prior->attempt_id === $attemptId && $prior->session_id === $session->id
                    && (int) $prior->proved_by === (int) $request->user()->id, 404);
                abort_unless($prior->proof_request_hash === $hash, 409, 'طلب الإثبات تغير؛ حمّل أحدث البيانات.');
                if ($prior->source_session_id) {
                    $this->sourceAbsence($attemptId, $prior->source_session_id, $permissions, false);
                }

                return response()->json(['booking' => $prior, 'replayed' => true]);
            }
            $this->validAttempt($attempt, $data['attempt_revision'], $session);
            abort_if($session->status !== 'held' || ! $session->closed_at
                || (int) $session->revision !== $data['session_revision'], 409, 'تغير اعتماد المحاضرة؛ حمّل أحدث البيانات.');
            $this->eligible($attempt, $session, $permissions, $data['source_session_id'] ?? null);
            $booking = DB::connection('tenant')->table('study_makeup_bookings')
                ->where('attempt_id', $attemptId)->where('session_id', $session->id)->first();
            abort_if($booking && $booking->source_session_id !== ($data['source_session_id'] ?? null), 409,
                'تغير مصدر التعويض؛ حمّل أحدث البيانات.');
            abort_if(DB::connection('tenant')->table('study_attendance_entries')->where('attempt_id', $attemptId)
                ->where('session_id', $session->id)->exists(), 409, 'سُجل حضور التعويض سابقًا.');
            $now = now();
            if ($booking) {
                DB::connection('tenant')->table('study_makeup_bookings')->where('id', $booking->id)->update([
                    'proved_by' => $request->user()->id, 'proved_at' => $now, 'proof_reason' => $reason,
                    'proof_request_id' => $data['request_id'], 'proof_request_hash' => $hash, 'updated_at' => $now]);
                $bookingId = $booking->id;
            } else {
                $bookingId = (string) Str::uuid();
                DB::connection('tenant')->table('study_makeup_bookings')->insert([
                    'id' => $bookingId, 'attempt_id' => $attemptId, 'session_id' => $session->id,
                    'source_session_id' => $data['source_session_id'] ?? null,
                    'booked_by' => $request->user()->id, 'booked_at' => $now,
                    'proved_by' => $request->user()->id, 'proved_at' => $now, 'proof_reason' => $reason,
                    'request_id' => $data['request_id'], 'request_hash' => $hash,
                    'proof_request_id' => $data['request_id'], 'proof_request_hash' => $hash,
                    'created_at' => $now, 'updated_at' => $now]);
            }
            $entryId = (string) Str::uuid();
            DB::connection('tenant')->table('study_attendance_entries')->insert([
                'id' => $entryId, 'session_id' => $session->id, 'attempt_id' => $attemptId,
                'status' => 'counted', 'revision' => 1, 'recorded_by' => $request->user()->id,
                'recorded_at' => $now, 'created_at' => $now, 'updated_at' => $now]);
            DB::connection('tenant')->table('study_attendance_events')->insert([
                'id' => (string) Str::uuid(), 'session_id' => $session->id, 'attempt_id' => $attemptId,
                'kind' => 'makeup_prove', 'session_revision' => $session->revision + 1,
                'before_status' => null, 'after_status' => 'counted', 'actor_id' => $request->user()->id,
                'reason' => $reason, 'created_at' => $now]);
            DB::connection('tenant')->table('study_sessions')->where('id', $session->id)->update([
                'revision' => $session->revision + 1, 'updated_at' => $now]);
            $this->audit($request->user()->id, (int) $session->branch_id, 'study_makeup.proved', [
                'attempt_id' => $attemptId, 'student_id' => $studentId, 'group_id' => $session->group_id,
                'session_id' => $session->id,
                'booking_id' => $bookingId, 'entry_id' => $entryId, 'before' => null, 'after' => 'counted',
                'reason' => $reason]);

            return response()->json(['booking_id' => $bookingId, 'entry_id' => $entryId,
                'session_revision' => $session->revision + 1], 201);
        });
    }

    private function attempt(string $studentId, string $attemptId, CenterPermissions $permissions, bool $lock = false): object
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($attemptId), 404);
        $query = StudentPhotos::visibleStudent($studentId, $permissions, 'enrollment.manage')
            ->join('study_attempts as attempts', 'attempts.student_id', '=', 'students.id')
            ->leftJoin('study_attempt_withdrawals as withdrawals', 'withdrawals.attempt_id', '=', 'attempts.id')
            ->where('attempts.id', $attemptId)
            ->whereExists(DB::connection('tenant')->table('student_branches')
                ->whereColumn('student_branches.student_id', 'students.id')
                ->whereColumn('student_branches.branch_id', 'attempts.branch_id')->selectRaw('1'))
            ->select(['attempts.id', 'attempts.student_id', 'attempts.branch_id', 'attempts.current_group_id', 'attempts.plan_version_id',
                'attempts.joined_on',
                'attempts.status', 'attempts.revision', 'withdrawals.withdrawn_on',
                'students.status as student_status', 'students.name as student_name']);
        if ($lock) {
            $query->lock('FOR UPDATE OF students, attempts');
        }
        $attempt = $query->first();
        abort_unless($attempt && $permissions->can('enrollment.manage', (int) $attempt->branch_id), 404);

        return $attempt;
    }

    private function session(string $sessionId, CenterPermissions $permissions, string $action): object
    {
        $session = DB::connection('tenant')->table('study_sessions as sessions')
            ->join('study_groups as groups', 'groups.id', '=', 'sessions.group_id')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->where('sessions.id', $sessionId)
            ->select(['sessions.id', 'sessions.group_id', 'sessions.plan_lecture_id', 'sessions.scheduled_at', 'sessions.status',
                'sessions.revision', 'sessions.closed_at', 'groups.plan_version_id', 'courses.branch_id'])
            ->lockForUpdate()->first();
        abort_unless($session && $permissions->can($action, (int) $session->branch_id), 404);

        return $session;
    }

    private function validAttempt(object $attempt, int $revision, ?object $historicalSession = null): void
    {
        abort_if($attempt->student_status !== 'active', 409, 'الطالب أو المحاولة غير متاحين للتعويض.');
        if ($historicalSession === null) {
            abort_if($attempt->status === 'withdrawn', 409, 'الطالب أو المحاولة غير متاحين للتعويض.');
        } elseif ($attempt->status === 'withdrawn') {
            $sessionDate = (new DateTimeImmutable($historicalSession->scheduled_at))
                ->setTimezone(new DateTimeZone('Africa/Cairo'))->format('Y-m-d');
            abort_if($attempt->withdrawn_on === null || $attempt->withdrawn_on <= $sessionDate, 409,
                'سُحبت محاولة الطالب قبل محاضرة التعويض.');
        }
        abort_if((int) $attempt->revision !== $revision, 409, 'تغيرت محاولة الدراسة؛ حمّل أحدث البيانات.');
    }

    private function eligible(object $attempt, object $session, CenterPermissions $permissions, ?string $sourceSessionId): void
    {
        $sessionDate = (new DateTimeImmutable($session->scheduled_at))
            ->setTimezone(new DateTimeZone('Africa/Cairo'))->format('Y-m-d');
        abort_if($sessionDate < $attempt->joined_on, 422,
            'لا يمكن احتساب محاضرة سبقت بداية محاولة الدراسة.');
        $primaryAtSession = DB::connection('tenant')->table('study_attempt_group_periods')
            ->where('attempt_id', $attempt->id)->where('group_id', $session->group_id)
            ->where('joined_on', '<=', $sessionDate)
            ->where(fn ($query) => $query->whereNull('left_on')->orWhere('left_on', '>', $sessionDate))
            ->exists();
        abort_if(DB::connection('tenant')->table('student_suspensions')->where('student_id', $attempt->student_id)
            ->where('suspended_at', '<=', $session->scheduled_at)
            ->where(fn ($query) => $query->whereNull('lifted_at')->orWhere('lifted_at', '>', $session->scheduled_at))
            ->exists(), 409, 'كان ملف الطالب موقوفًا وقت محاضرة التعويض.');
        abort_if($primaryAtSession || ! $session->plan_lecture_id, 422,
            'اختر محاضرة تعويض من مجموعة أخرى لها محتوى معتمد.');
        $sourceLectureId = $sourceSessionId === null ? null
            : $this->sourceAbsence($attempt->id, $sourceSessionId, $permissions)->plan_lecture_id;
        $requirements = DB::connection('tenant')->table('plan_lectures')
            ->where('plan_version_id', $attempt->plan_version_id)->pluck('id')->all();
        $attendance = DB::connection('tenant')->table('study_attendance_entries as entries')
            ->join('study_sessions as sessions', 'sessions.id', '=', 'entries.session_id')
            ->where('entries.attempt_id', $attempt->id)->where('entries.status', 'counted')
            ->where('sessions.status', '<>', 'cancelled')
            ->get(['sessions.plan_lecture_id as id', 'sessions.closed_at'])
            ->filter(fn ($row): bool => $row->id !== null)
            ->map(fn ($row): array => ['id' => $row->id, 'final' => $row->closed_at !== null])->all();
        $approvals = DB::connection('tenant')->table('content_equivalences as approvals')
            ->where(function ($query) use ($attempt): void {
                $query->where('approvals.target_plan_version_id', $attempt->plan_version_id)
                    ->orWhereExists(DB::connection('tenant')->table('study_attempt_transfers as transfers')
                        ->where('transfers.attempt_id', $attempt->id)
                        ->whereColumn('transfers.to_plan_version_id', 'approvals.target_plan_version_id')
                        ->selectRaw('1'));
            })
            ->get(['approvals.id', 'approvals.source_lecture_ids', 'approvals.target_lecture_ids'])
            ->map(fn ($row): array => ['id' => $row->id,
                'source_lecture_ids' => json_decode($row->source_lecture_ids, true),
                'target_lecture_ids' => json_decode($row->target_lecture_ids, true)])->all();
        $before = StudyCoverageCredits::resolve($attendance, $approvals)['lectures'];
        $after = StudyCoverageCredits::resolve([...$attendance,
            ['id' => $session->plan_lecture_id, 'final' => $session->closed_at !== null]], $approvals)['lectures'];
        $new = array_diff(array_intersect($requirements, array_keys($after)), array_keys($before));
        abort_if($new === [], 422, 'لا يغطي التعويض محتوى ناقصًا من خطة المحاولة بمعادلة معتمدة.');
        if ($sourceLectureId !== null) {
            $sourceCoverage = StudyCoverageCredits::resolve([...$attendance,
                ['id' => $sourceLectureId, 'final' => true]], $approvals)['lectures'];
            abort_if(array_intersect($new, array_keys($sourceCoverage)) === [], 422,
                'المحاضرة المختارة لا تعوّض محتوى الغياب الأصلي المرتبط.');
        }
    }

    private function branches(CenterPermissions $permissions, string $action): array
    {
        return array_keys(array_filter($permissions->branchRoles,
            fn (array $roles): bool => in_array($action, CenterPermissions::actions($roles), true)));
    }

    private function sourceAbsence(string $attemptId, string $sessionId, CenterPermissions $permissions, bool $mustBeAbsent = true): object
    {
        $source = DB::connection('tenant')->table('study_attendance_entries as entries')
            ->join('study_sessions as sessions', 'sessions.id', '=', 'entries.session_id')
            ->join('study_groups as groups', 'groups.id', '=', 'sessions.group_id')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->where('entries.attempt_id', $attemptId)->where('entries.session_id', $sessionId)
            ->when($mustBeAbsent, fn ($query) => $query->where('entries.status', 'absent')
                ->where('sessions.status', '<>', 'cancelled'))
            ->first(['sessions.plan_lecture_id', 'courses.branch_id']);
        abort_unless($source && $permissions->can('read', (int) $source->branch_id), 404);

        return $source;
    }

    private function audit(int $actorId, int $branchId, string $event, array $details): void
    {
        DB::connection('tenant')->table('center_audit_logs')->insert(['actor_id' => $actorId, 'branch_id' => $branchId,
            'event' => $event, 'details' => json_encode($details), 'created_at' => now()]);
    }
}
