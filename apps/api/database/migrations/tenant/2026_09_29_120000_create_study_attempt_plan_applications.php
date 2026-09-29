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
            $table->jsonb('required_lectures')->nullable();
        });

        Schema::create('study_attempt_plan_applications', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('attempt_id')->constrained('study_attempts')->restrictOnDelete();
            $table->foreignUuid('group_id')->constrained('study_groups')->restrictOnDelete();
            $table->foreignUuid('from_plan_version_id')->constrained('study_plan_versions')->restrictOnDelete();
            $table->foreignUuid('to_plan_version_id')->constrained('study_plan_versions')->restrictOnDelete();
            $table->jsonb('before_requirements');
            $table->jsonb('after_requirements');
            $table->jsonb('before_coverage');
            $table->jsonb('after_coverage');
            $table->jsonb('completion_decision')->nullable();
            $table->jsonb('approval_ids');
            $table->text('reason');
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_name');
            $table->uuid('request_id');
            $table->char('request_hash', 64);
            $table->timestampTz('approved_at');
            $table->unique(['request_id', 'attempt_id']);
            $table->index(['attempt_id', 'approved_at']);
        });
        DB::statement('ALTER TABLE study_attempt_plan_applications ADD CONSTRAINT plan_application_distinct_versions CHECK (from_plan_version_id <> to_plan_version_id)');

        Schema::create('study_plan_application_submissions', function (Blueprint $table): void {
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
        if (DB::table('study_attempt_plan_applications')->exists()
            || DB::table('study_plan_application_submissions')->exists()) {
            throw new RuntimeException('Cannot roll back approved study plan applications.');
        }
        Schema::dropIfExists('study_plan_application_submissions');
        Schema::dropIfExists('study_attempt_plan_applications');
        Schema::table('study_attempts', fn (Blueprint $table) => $table->dropColumn('required_lectures'));
    }
};
