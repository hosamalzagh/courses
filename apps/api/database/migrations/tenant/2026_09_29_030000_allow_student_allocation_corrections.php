<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        DB::statement('ALTER TABLE student_allocation_submissions DROP CONSTRAINT student_allocation_submission_kind');
        DB::statement("ALTER TABLE student_allocation_submissions ADD CONSTRAINT student_allocation_submission_kind CHECK (kind IN ('allocate', 'reverse', 'correct'))");
        Schema::table('student_payment_allocations', fn (Blueprint $table) => $table->index('submission_id'));
    }

    public function down(): void
    {
        if (DB::table('student_allocation_submissions')->where('kind', 'correct')->exists()) {
            throw new RuntimeException('Cannot roll back approved allocation corrections.');
        }

        Schema::table('student_payment_allocations', fn (Blueprint $table) => $table->dropIndex(['submission_id']));
        DB::statement('ALTER TABLE student_allocation_submissions DROP CONSTRAINT student_allocation_submission_kind');
        DB::statement("ALTER TABLE student_allocation_submissions ADD CONSTRAINT student_allocation_submission_kind CHECK (kind IN ('allocate', 'reverse'))");
    }
};
