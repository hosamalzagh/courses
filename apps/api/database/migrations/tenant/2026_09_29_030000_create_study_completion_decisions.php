<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('study_groups', function (Blueprint $table): void {
            $table->timestampTz('completed_at')->nullable();
            $table->unsignedBigInteger('completed_by')->nullable();
            $table->string('completed_by_name')->nullable();
        });
        Schema::create('study_attempt_completion_decisions', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('attempt_id')->unique()->constrained('study_attempts')->restrictOnDelete();
            $table->foreignUuid('group_id')->constrained('study_groups')->restrictOnDelete();
            $table->foreignUuid('student_id')->constrained('students')->restrictOnDelete();
            $table->foreignId('branch_id')->constrained('branches')->restrictOnDelete();
            $table->boolean('exceptional');
            $table->text('reason')->nullable();
            $table->unsignedSmallInteger('covered_count');
            $table->unsignedSmallInteger('required_count');
            $table->unsignedTinyInteger('completion_threshold');
            $table->jsonb('covered_numbers');
            $table->jsonb('missing_numbers');
            $table->unsignedBigInteger('approved_by');
            $table->string('approved_by_name');
            $table->timestampTz('approved_at');
            $table->uuid('request_id');
            $table->index(['group_id', 'approved_at']);
        });
        DB::statement('ALTER TABLE study_attempt_completion_decisions ADD CONSTRAINT study_completion_reason_valid CHECK ((exceptional AND length(trim(reason)) >= 3) OR (NOT exceptional AND reason IS NULL))');
        Schema::create('study_completion_submissions', function (Blueprint $table): void {
            $table->uuid('request_id')->primary();
            $table->foreignUuid('group_id')->constrained('study_groups')->restrictOnDelete();
            $table->unsignedBigInteger('actor_id');
            $table->char('request_hash', 64);
            $table->jsonb('result');
            $table->timestampTz('created_at');
        });
    }

    public function down(): void
    {
        if (DB::table('study_attempt_completion_decisions')->exists()
            || DB::table('study_completion_submissions')->exists()) {
            throw new RuntimeException('Cannot roll back recorded study completion decisions.');
        }
        Schema::dropIfExists('study_completion_submissions');
        Schema::dropIfExists('study_attempt_completion_decisions');
        Schema::table('study_groups', fn (Blueprint $table) => $table->dropColumn(['completed_at', 'completed_by', 'completed_by_name']));
    }
};
