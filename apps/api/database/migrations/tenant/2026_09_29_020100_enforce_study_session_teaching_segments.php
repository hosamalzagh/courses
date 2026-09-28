<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::statement('ALTER TABLE study_session_teaching_segments ADD CONSTRAINT teaching_segment_time_valid CHECK (start_minute >= 0 AND duration_minutes > 0 AND start_minute + duration_minutes <= 720)');
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE study_session_teaching_segments DROP CONSTRAINT teaching_segment_time_valid');
    }
};
