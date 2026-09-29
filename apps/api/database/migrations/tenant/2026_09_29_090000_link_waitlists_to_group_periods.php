<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('study_attempt_waitlists', function (Blueprint $table): void {
            $table->foreignUuid('origin_period_id')->nullable()->constrained('study_attempt_group_periods')->restrictOnDelete();
            $table->unsignedInteger('entry_revision')->nullable();
            $table->index('origin_period_id');
        });

        // Use the most recent preceding period when its timestamp identifies it.
        // Same-second repeat visits cannot be reconstructed reliably.
        DB::statement(<<<'SQL'
            UPDATE study_attempt_waitlists AS waitlists
            SET origin_period_id = periods.id
            FROM study_attempt_group_periods AS periods
            WHERE periods.attempt_id = waitlists.attempt_id
                AND periods.group_id = waitlists.from_group_id
                AND periods.left_on = waitlists.entered_on
                AND periods.created_at <= waitlists.created_at
                AND NOT EXISTS (
                    SELECT 1 FROM study_attempt_group_periods AS other
                    WHERE other.attempt_id = waitlists.attempt_id
                        AND other.group_id = waitlists.from_group_id
                        AND other.left_on = waitlists.entered_on
                        AND other.created_at <= waitlists.created_at
                        AND other.created_at >= periods.created_at
                        AND other.id <> periods.id
                )
            SQL);
    }

    public function down(): void
    {
        Schema::table('study_attempt_waitlists', function (Blueprint $table): void {
            $table->dropForeign(['origin_period_id']);
            $table->dropColumn('entry_revision');
            $table->dropColumn('origin_period_id');
        });
    }
};
