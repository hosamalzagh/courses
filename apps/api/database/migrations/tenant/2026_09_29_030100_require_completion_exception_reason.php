<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::statement('ALTER TABLE study_attempt_completion_decisions DROP CONSTRAINT study_completion_reason_valid');
        DB::statement('ALTER TABLE study_attempt_completion_decisions ADD CONSTRAINT study_completion_reason_valid CHECK ((exceptional AND reason IS NOT NULL AND length(trim(reason)) >= 3) OR (NOT exceptional AND reason IS NULL))');
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE study_attempt_completion_decisions DROP CONSTRAINT study_completion_reason_valid');
        DB::statement('ALTER TABLE study_attempt_completion_decisions ADD CONSTRAINT study_completion_reason_valid CHECK ((exceptional AND length(trim(reason)) >= 3) OR (NOT exceptional AND reason IS NULL))');
    }
};
