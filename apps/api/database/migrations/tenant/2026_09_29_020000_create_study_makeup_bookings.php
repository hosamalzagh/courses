<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('study_makeup_bookings', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('attempt_id')->constrained('study_attempts')->restrictOnDelete();
            $table->foreignUuid('session_id')->constrained('study_sessions')->restrictOnDelete();
            $table->foreignUuid('source_session_id')->nullable()->constrained('study_sessions')->restrictOnDelete();
            $table->unsignedBigInteger('booked_by');
            $table->timestampTz('booked_at');
            $table->unsignedBigInteger('proved_by')->nullable();
            $table->timestampTz('proved_at')->nullable();
            $table->text('proof_reason')->nullable();
            $table->uuid('request_id')->unique();
            $table->char('request_hash', 64);
            $table->uuid('proof_request_id')->nullable()->unique();
            $table->char('proof_request_hash', 64)->nullable();
            $table->timestampsTz();
            $table->unique(['attempt_id', 'session_id']);
            $table->index(['session_id', 'attempt_id']);
            $table->index(['source_session_id', 'attempt_id']);
        });
        DB::statement('ALTER TABLE study_attendance_events DROP CONSTRAINT study_attendance_event_kind_valid');
        DB::statement("ALTER TABLE study_attendance_events ADD CONSTRAINT study_attendance_event_kind_valid CHECK (kind IN ('record', 'undo', 'close', 'correct', 'makeup_prove'))");
    }

    public function down(): void
    {
        if (DB::table('study_makeup_bookings')->exists()
            || DB::table('study_attendance_events')->where('kind', 'makeup_prove')->exists()) {
            throw new RuntimeException('Cannot roll back makeup bookings or attendance proof history.');
        }
        DB::statement('ALTER TABLE study_attendance_events DROP CONSTRAINT study_attendance_event_kind_valid');
        DB::statement("ALTER TABLE study_attendance_events ADD CONSTRAINT study_attendance_event_kind_valid CHECK (kind IN ('record', 'undo', 'close', 'correct'))");
        Schema::dropIfExists('study_makeup_bookings');
    }
};
