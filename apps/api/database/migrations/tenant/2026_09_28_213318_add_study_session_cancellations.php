<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('study_sessions', function (Blueprint $table): void {
            $table->timestampTz('cancelled_at')->nullable();
            $table->unsignedBigInteger('cancelled_by')->nullable();
            $table->string('cancelled_by_name')->nullable();
            $table->text('cancellation_reason')->nullable();
            $table->string('compensation_decision', 20)->nullable();
            $table->foreignUuid('replaces_session_id')->nullable()->constrained('study_sessions')->restrictOnDelete()->unique();
        });
        DB::statement("ALTER TABLE study_sessions ADD CONSTRAINT study_session_cancellation_complete CHECK (
            (cancelled_at IS NULL AND cancelled_by IS NULL AND cancelled_by_name IS NULL
                AND cancellation_reason IS NULL AND compensation_decision IS NULL)
            OR (cancelled_at IS NOT NULL AND status = 'cancelled' AND cancelled_by IS NOT NULL
                AND cancelled_by_name IS NOT NULL AND cancellation_reason IS NOT NULL
                AND compensation_decision IN ('academic', 'financial', 'none'))
        )");
        DB::statement('ALTER TABLE study_sessions ADD CONSTRAINT study_session_not_self_replacement CHECK (replaces_session_id IS NULL OR replaces_session_id <> id)');
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE study_sessions DROP CONSTRAINT study_session_not_self_replacement');
        DB::statement('ALTER TABLE study_sessions DROP CONSTRAINT study_session_cancellation_complete');
        Schema::table('study_sessions', fn (Blueprint $table) => $table->dropConstrainedForeignId('replaces_session_id'));
        Schema::table('study_sessions', fn (Blueprint $table) => $table->dropColumn([
            'cancelled_at', 'cancelled_by', 'cancelled_by_name', 'cancellation_reason', 'compensation_decision',
        ]));
    }
};
