<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
INSERT INTO study_attendance_entries
    (id, session_id, attempt_id, status, revision, recorded_by, recorded_at, created_at, updated_at)
SELECT gen_random_uuid(), sessions.id, attempts.id, NULL, 1, NULL, NULL, sessions.closed_at, sessions.closed_at
FROM study_sessions AS sessions
JOIN study_attempt_group_periods AS periods
    ON periods.group_id = sessions.group_id
    AND periods.joined_on <= (sessions.scheduled_at AT TIME ZONE 'Africa/Cairo')::date
    AND (periods.left_on IS NULL OR periods.left_on > (sessions.scheduled_at AT TIME ZONE 'Africa/Cairo')::date)
    AND periods.created_at < (sessions.closed_at AT TIME ZONE 'UTC')
JOIN study_attempts AS attempts
    ON attempts.id = periods.attempt_id
    AND attempts.created_at < (sessions.closed_at AT TIME ZONE 'UTC')
JOIN student_suspensions AS suspensions
    ON suspensions.student_id = attempts.student_id
    AND suspensions.suspended_at <= sessions.scheduled_at
    AND (suspensions.lifted_at IS NULL OR suspensions.lifted_at > sessions.scheduled_at)
WHERE sessions.closed_at IS NOT NULL
ON CONFLICT (session_id, attempt_id) DO NOTHING
SQL);
    }

    public function down(): void
    {
        // These entries are part of a closed attendance roster and must keep its history intact.
    }
};
