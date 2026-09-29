<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('study_attempt_group_periods', function (Blueprint $table): void {
            $table->jsonb('required_credit_ids')->nullable();
        });

        // Existing waitlists and withdrawals already have closed source periods.
        // Freeze their historical requirements before later group edits can change
        // the credits that these attempts still need for makeup.
        DB::statement(<<<'SQL'
UPDATE study_attempt_group_periods AS periods
SET required_credit_ids = COALESCE((
    SELECT jsonb_agg(COALESCE(requirements.plan_lecture_id, requirements.id)
        ORDER BY requirements.number)
    FROM study_group_requirements AS requirements
    WHERE requirements.group_id = periods.group_id
        AND (requirements.plan_lecture_id IS NOT NULL
            OR (requirements.created_at AT TIME ZONE 'Africa/Cairo')::date <= periods.left_on)
        AND (requirements.retired_at IS NULL
            OR (requirements.retired_at AT TIME ZONE 'Africa/Cairo')::date > periods.left_on)
), '[]'::jsonb)
WHERE periods.left_on IS NOT NULL AND periods.required_credit_ids IS NULL
SQL);
    }

    public function down(): void
    {
        if (DB::table('study_attempt_group_periods')->whereNotNull('required_credit_ids')->exists()) {
            throw new RuntimeException('Cannot discard frozen study period requirements.');
        }
        Schema::table('study_attempt_group_periods', function (Blueprint $table): void {
            $table->dropColumn('required_credit_ids');
        });
    }
};
