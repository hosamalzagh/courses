<?php

namespace App\Support;

use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class StudyWaitlistEntry
{
    public static function enter(
        string $studentId,
        string $attemptId,
        string $enteredOn,
        string $reason,
        int $revision,
        string $requestId,
        int $actorId,
        string $actorName,
        CenterPermissions $permissions,
        ?string $batchId = null,
    ): array {
        $student = StudentPhotos::visibleStudent($studentId, $permissions, 'enrollment.manage')
            ->lockForUpdate()->first(['students.id', 'students.status']);
        abort_unless($student, 404);
        $attempt = DB::connection('tenant')->table('study_attempts')->where('id', $attemptId)
            ->where('student_id', $studentId)->lockForUpdate()->first();
        abort_unless($attempt && $permissions->can('enrollment.manage', (int) $attempt->branch_id), 404);
        abort_unless(DB::connection('tenant')->table('student_branches')->where('student_id', $studentId)
            ->where('branch_id', $attempt->branch_id)->exists(), 404);

        $hash = hash('sha256', json_encode([$studentId, $attemptId, $enteredOn, $reason]));
        $previous = DB::connection('tenant')->table('study_attempt_waitlists')
            ->where('entry_request_id', $requestId)->first();
        if ($previous !== null) {
            abort_unless($previous->attempt_id === $attemptId && (int) $previous->entered_by === $actorId, 403);
            if ($previous->entry_request_hash !== $hash) {
                self::conflict('waitlist_request_changed');
            }

            return [$previous, false];
        }
        if ($student->status !== 'active' || $attempt->status !== 'active' || $attempt->current_group_id === null
            || (int) $attempt->revision !== $revision) {
            self::conflict('attempt_changed');
        }
        $period = DB::connection('tenant')->table('study_attempt_group_periods')
            ->where('attempt_id', $attemptId)->whereNull('left_on')->lockForUpdate()->first(['id', 'group_id', 'joined_on']);
        if ($period === null || $period->group_id !== $attempt->current_group_id) {
            self::conflict('attempt_changed');
        }
        abort_if($enteredOn < $period->joined_on, 422, 'تاريخ الانتظار يسبق الانضمام الحالي.');
        $recordedAttendance = DB::connection('tenant')->table('study_attendance_entries as entries')
            ->join('study_sessions as sessions', 'sessions.id', '=', 'entries.session_id')
            ->where('entries.attempt_id', $attemptId)->where('sessions.group_id', $period->group_id)
            ->whereNotNull('entries.status')
            ->where('sessions.status', '<>', 'cancelled')
            ->whereRaw("(sessions.scheduled_at AT TIME ZONE 'Africa/Cairo')::date >= ?::date", [$enteredOn])
            ->exists();
        abort_if($recordedAttendance, 422, 'تاريخ الانتظار يسبق حضورًا مسجلًا أو يوافق يومه.');

        $now = now();
        $waitlistId = (string) Str::uuid();
        DB::connection('tenant')->table('study_attempt_group_periods')->where('id', $period->id)
            ->update(['left_on' => $enteredOn]);
        DB::connection('tenant')->table('study_attempts')->where('id', $attemptId)->update([
            'current_group_id' => null, 'revision' => $attempt->revision + 1, 'updated_at' => $now,
        ]);
        DB::connection('tenant')->table('study_attempt_waitlists')->insert([
            'id' => $waitlistId, 'attempt_id' => $attemptId, 'from_group_id' => $period->group_id,
            'branch_id' => $attempt->branch_id, 'entered_on' => $enteredOn, 'reason' => $reason,
            'entered_by' => $actorId, 'entered_by_name' => $actorName,
            'entry_request_id' => $requestId, 'entry_request_hash' => $hash,
            'created_at' => $now, 'updated_at' => $now,
        ]);
        DB::connection('tenant')->table('center_audit_logs')->insert([
            'actor_id' => $actorId, 'branch_id' => $attempt->branch_id,
            'event' => 'student.study_waitlisted',
            'details' => json_encode(['student_id' => $studentId, 'attempt_id' => $attemptId,
                'from_group_id' => $period->group_id, 'entered_on' => $enteredOn, 'reason' => $reason,
                'batch_id' => $batchId]),
            'created_at' => $now,
        ]);

        return [DB::connection('tenant')->table('study_attempt_waitlists')->where('id', $waitlistId)->firstOrFail(), true];
    }

    private static function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
