<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('study_attempts', function (Blueprint $table): void {
            $table->unsignedTinyInteger('completion_threshold')->nullable();
        });

        // Each registration has an audit entry before any later setting change.
        // Replay the first later change's "before" value for each override;
        // falling back to today's value only when that override never changed.
        $missingAudit = DB::selectOne(<<<'SQL'
SELECT count(*) AS total FROM study_attempts AS attempts
WHERE NOT EXISTS (SELECT 1 FROM center_audit_logs AS enrollment
    WHERE enrollment.event = 'student.enrolled'
      AND enrollment.details->>'attempt_id' = attempts.id::text)
SQL)->total;
        if ($missingAudit > 0) {
            throw new RuntimeException("Cannot reconstruct completion thresholds for {$missingAudit} attempts without enrollment audit records.");
        }

        DB::statement(<<<'SQL'
WITH historical AS (
    SELECT attempts.id,
        COALESCE(
            CASE WHEN group_change.id IS NULL THEN groups.completion_threshold
                ELSE (group_change.details->'before'->>'completion_threshold_override')::integer END,
            CASE WHEN level_change.id IS NULL THEN levels.completion_threshold
                ELSE (level_change.details->'before'->>'completion_threshold')::integer END,
            CASE WHEN stage_change.id IS NULL THEN stages.completion_threshold
                ELSE (stage_change.details->'before'->>'completion_threshold')::integer END,
            CASE WHEN course_change.id IS NULL THEN courses.completion_threshold
                ELSE (course_change.details->'before'->>'completion_threshold')::integer END
        ) AS threshold
    FROM study_attempts AS attempts
    JOIN study_groups AS groups ON groups.id = attempts.current_group_id
    JOIN levels ON levels.id = groups.level_id
    JOIN stages ON stages.id = levels.stage_id
    JOIN courses ON courses.id = stages.course_id
    JOIN center_audit_logs AS enrollment ON enrollment.event = 'student.enrolled'
        AND enrollment.details->>'attempt_id' = attempts.id::text
    LEFT JOIN LATERAL (
        SELECT id, details FROM center_audit_logs
        WHERE event = 'study_group.settings_updated' AND details->>'record_id' = groups.id::text
          AND id > enrollment.id ORDER BY id LIMIT 1
    ) AS group_change ON true
    LEFT JOIN LATERAL (
        SELECT id, details FROM center_audit_logs
        WHERE event = 'curriculum.completion_threshold_changed' AND details->>'kind' = 'levels'
          AND details->>'record_id' = levels.id::text AND id > enrollment.id ORDER BY id LIMIT 1
    ) AS level_change ON true
    LEFT JOIN LATERAL (
        SELECT id, details FROM center_audit_logs
        WHERE event = 'curriculum.completion_threshold_changed' AND details->>'kind' = 'stages'
          AND details->>'record_id' = stages.id::text AND id > enrollment.id ORDER BY id LIMIT 1
    ) AS stage_change ON true
    LEFT JOIN LATERAL (
        SELECT id, details FROM center_audit_logs
        WHERE event = 'curriculum.completion_threshold_changed' AND details->>'kind' = 'courses'
          AND details->>'record_id' = courses.id::text AND id > enrollment.id ORDER BY id LIMIT 1
    ) AS course_change ON true
)
UPDATE study_attempts AS attempts SET completion_threshold = historical.threshold
FROM historical WHERE attempts.id = historical.id
SQL);
        DB::statement('ALTER TABLE study_attempts ALTER COLUMN completion_threshold SET NOT NULL');
        DB::statement('ALTER TABLE study_attempts ADD CONSTRAINT study_attempt_completion_threshold_valid CHECK (completion_threshold BETWEEN 1 AND 100)');
    }

    public function down(): void
    {
        if (DB::table('study_attempts')->exists()) {
            throw new RuntimeException('Cannot roll back approved completion thresholds for study attempts.');
        }

        Schema::table('study_attempts', fn (Blueprint $table) => $table->dropColumn('completion_threshold'));
    }
};
