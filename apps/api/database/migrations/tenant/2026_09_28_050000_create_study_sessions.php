<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('study_sessions', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('group_id')->constrained('study_groups')->restrictOnDelete();
            $table->foreignUuid('plan_lecture_id')->constrained('plan_lectures')->restrictOnDelete();
            $table->unsignedInteger('number');
            $table->string('title')->nullable();
            $table->timestampTz('scheduled_at');
            $table->string('status', 20)->default('planned');
            $table->unsignedInteger('revision')->default(1);
            $table->unsignedBigInteger('created_by');
            $table->string('created_by_name');
            $table->timestampsTz();
            $table->unique(['group_id', 'number']);
            $table->index(['group_id', 'scheduled_at', 'id']);
        });
        DB::statement("ALTER TABLE study_sessions ADD CONSTRAINT study_session_status_valid CHECK (status IN ('planned', 'held', 'cancelled'))");
        DB::statement('CREATE UNIQUE INDEX study_session_active_requirement ON study_sessions (group_id, plan_lecture_id) WHERE status <> \'cancelled\'');
        DB::statement('CREATE UNIQUE INDEX study_session_active_time ON study_sessions (group_id, scheduled_at) WHERE status <> \'cancelled\'');
        Schema::create('study_session_submissions', function (Blueprint $table): void {
            $table->uuid('request_id')->primary();
            $table->foreignUuid('group_id')->constrained('study_groups')->restrictOnDelete();
            $table->string('kind', 20);
            $table->char('request_hash', 64);
            $table->unsignedBigInteger('actor_id');
            $table->jsonb('session_ids');
            $table->timestampTz('created_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('study_session_submissions');
        Schema::dropIfExists('study_sessions');
    }
};
