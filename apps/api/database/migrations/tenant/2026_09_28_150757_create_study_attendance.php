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
            $table->index(['group_id', 'joined_on', 'left_on', 'attempt_id'], 'study_periods_group_date_attempt_idx');
        });
        Schema::table('study_sessions', function (Blueprint $table): void {
            $table->timestampTz('closed_at')->nullable();
            $table->unsignedBigInteger('closed_by')->nullable();
        });

        Schema::create('study_attendance_entries', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('session_id')->constrained('study_sessions')->restrictOnDelete();
            $table->foreignUuid('attempt_id')->constrained('study_attempts')->restrictOnDelete();
            $table->string('status', 20)->nullable();
            $table->unsignedInteger('revision')->default(1);
            $table->unsignedBigInteger('recorded_by')->nullable();
            $table->timestampTz('recorded_at')->nullable();
            $table->timestampsTz();
            $table->unique(['session_id', 'attempt_id']);
            $table->index(['attempt_id', 'session_id']);
        });
        DB::statement("ALTER TABLE study_attendance_entries ADD CONSTRAINT study_attendance_status_valid CHECK (status IS NULL OR status IN ('counted', 'not_counted', 'absent'))");

        Schema::create('study_attendance_events', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('session_id')->constrained('study_sessions')->restrictOnDelete();
            $table->foreignUuid('attempt_id')->nullable()->constrained('study_attempts')->restrictOnDelete();
            $table->string('kind', 20);
            $table->unsignedInteger('session_revision');
            $table->string('before_status', 20)->nullable();
            $table->string('after_status', 20)->nullable();
            $table->unsignedBigInteger('actor_id');
            $table->timestampTz('created_at');
            $table->index(['session_id', 'actor_id', 'created_at']);
            $table->unique(['session_id', 'session_revision']);
        });
        DB::statement("ALTER TABLE study_attendance_events ADD CONSTRAINT study_attendance_event_kind_valid CHECK (kind IN ('record', 'undo', 'close', 'correct'))");
        DB::statement(<<<'SQL'
CREATE FUNCTION preserve_study_attendance_event() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Attendance events are immutable';
END;
$$ LANGUAGE plpgsql;
SQL);
        DB::statement('CREATE TRIGGER preserve_study_attendance_event BEFORE UPDATE OR DELETE ON study_attendance_events FOR EACH ROW EXECUTE FUNCTION preserve_study_attendance_event()');

        Schema::create('study_attendance_submissions', function (Blueprint $table): void {
            $table->uuid('request_id')->primary();
            $table->foreignUuid('session_id')->constrained('study_sessions')->restrictOnDelete();
            $table->string('kind', 20);
            $table->char('request_hash', 64);
            $table->unsignedBigInteger('actor_id');
            $table->foreignUuid('entry_id')->nullable()->constrained('study_attendance_entries')->restrictOnDelete();
            $table->unsignedInteger('result_revision');
            $table->timestampTz('created_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('study_attendance_submissions');
        Schema::dropIfExists('study_attendance_events');
        DB::statement('DROP FUNCTION IF EXISTS preserve_study_attendance_event()');
        Schema::dropIfExists('study_attendance_entries');
        Schema::table('study_sessions', fn (Blueprint $table) => $table->dropColumn(['closed_at', 'closed_by']));
        Schema::table('study_attempt_group_periods', fn (Blueprint $table) => $table->dropIndex('study_periods_group_date_attempt_idx'));
    }
};
