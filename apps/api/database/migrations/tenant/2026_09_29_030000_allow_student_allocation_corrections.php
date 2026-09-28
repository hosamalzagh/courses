<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::statement('ALTER TABLE student_allocation_submissions DROP CONSTRAINT student_allocation_submission_kind');
        DB::statement("ALTER TABLE student_allocation_submissions ADD CONSTRAINT student_allocation_submission_kind CHECK (kind IN ('allocate', 'reverse', 'correct'))");
    }

    public function down(): void
    {
        if (DB::table('student_allocation_submissions')->where('kind', 'correct')->exists()) {
            throw new RuntimeException('Cannot roll back approved allocation corrections.');
        }

        DB::statement('ALTER TABLE student_allocation_submissions DROP CONSTRAINT student_allocation_submission_kind');
        DB::statement("ALTER TABLE student_allocation_submissions ADD CONSTRAINT student_allocation_submission_kind CHECK (kind IN ('allocate', 'reverse'))");
    }
};
