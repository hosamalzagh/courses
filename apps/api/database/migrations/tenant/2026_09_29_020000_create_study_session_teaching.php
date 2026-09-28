<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('study_sessions', function (Blueprint $table): void {
            $table->unsignedInteger('teaching_revision')->default(1);
        });
        Schema::create('study_session_teaching_segments', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('session_id')->constrained('study_sessions')->restrictOnDelete();
            $table->foreignUuid('instructor_id')->constrained('instructors')->restrictOnDelete();
            $table->unsignedSmallInteger('start_minute');
            $table->unsignedSmallInteger('duration_minutes');
            $table->unsignedBigInteger('recorded_by');
            $table->timestampsTz();
            $table->index(['session_id', 'start_minute']);
        });
        Schema::create('study_session_teaching_submissions', function (Blueprint $table): void {
            $table->uuid('request_id')->primary();
            $table->foreignUuid('session_id')->constrained('study_sessions')->restrictOnDelete();
            $table->unsignedBigInteger('actor_id');
            $table->char('request_hash', 64);
            $table->jsonb('result');
            $table->timestampTz('created_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('study_session_teaching_submissions');
        Schema::dropIfExists('study_session_teaching_segments');
        Schema::table('study_sessions', function (Blueprint $table): void {
            $table->dropColumn('teaching_revision');
        });
    }
};
