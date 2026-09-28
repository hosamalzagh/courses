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

        // Existing attempts receive the currently approved inherited threshold once.
        // Subsequent setting changes cannot silently change their eligibility.
        DB::statement(<<<'SQL'
UPDATE study_attempts AS attempts
SET completion_threshold = COALESCE(groups.completion_threshold, levels.completion_threshold,
    stages.completion_threshold, courses.completion_threshold)
FROM study_groups AS groups
JOIN levels ON levels.id = groups.level_id
JOIN stages ON stages.id = levels.stage_id
JOIN courses ON courses.id = stages.course_id
WHERE groups.id = attempts.current_group_id
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
