<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('study_group_requirements', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('group_id')->constrained('study_groups')->restrictOnDelete();
            $table->foreignUuid('plan_lecture_id')->nullable()->constrained('plan_lectures')->restrictOnDelete();
            $table->unsignedInteger('number');
            $table->text('content');
            $table->string('title')->nullable();
            $table->decimal('planned_hours', 6, 2)->nullable();
            $table->unsignedBigInteger('created_by')->nullable();
            $table->timestampTz('created_at');
            $table->timestampTz('retired_at')->nullable();
            $table->unique(['group_id', 'number']);
            $table->unique(['group_id', 'plan_lecture_id']);
            $table->index(['group_id', 'retired_at', 'number']);
        });
        DB::statement(<<<'SQL'
INSERT INTO study_group_requirements
    (id, group_id, plan_lecture_id, number, content, title, planned_hours, created_at)
SELECT gen_random_uuid(), groups.id, lectures.id, lectures.number, lectures.content,
    lectures.title, lectures.planned_hours, groups.created_at
FROM study_groups AS groups
JOIN plan_lectures AS lectures ON lectures.plan_version_id = groups.plan_version_id
SQL);

        Schema::table('study_sessions', function (Blueprint $table): void {
            $table->foreignUuid('group_requirement_id')->nullable()->after('plan_lecture_id')
                ->constrained('study_group_requirements')->restrictOnDelete();
        });
        DB::statement(<<<'SQL'
UPDATE study_sessions AS sessions
SET group_requirement_id = requirements.id
FROM study_group_requirements AS requirements
WHERE requirements.group_id = sessions.group_id
    AND requirements.plan_lecture_id = sessions.plan_lecture_id
SQL);
        DB::statement('ALTER TABLE study_sessions ALTER COLUMN group_requirement_id SET NOT NULL');
        DB::statement('ALTER TABLE study_sessions ALTER COLUMN plan_lecture_id DROP NOT NULL');
        DB::statement('DROP INDEX study_session_active_requirement');
        DB::statement("CREATE UNIQUE INDEX study_session_active_requirement ON study_sessions (group_id, group_requirement_id) WHERE status <> 'cancelled'");

        Schema::create('study_group_requirement_submissions', function (Blueprint $table): void {
            $table->uuid('request_id')->primary();
            $table->foreignUuid('group_id')->constrained('study_groups')->restrictOnDelete();
            $table->foreignUuid('requirement_id')->constrained('study_group_requirements')->restrictOnDelete();
            $table->string('kind', 20);
            $table->char('request_hash', 64);
            $table->unsignedBigInteger('actor_id');
            $table->jsonb('result');
            $table->timestampTz('created_at');
        });
    }

    public function down(): void
    {
        if (DB::table('study_group_requirement_submissions')->exists()
            || DB::table('study_sessions')->whereNull('plan_lecture_id')->exists()) {
            throw new RuntimeException('Approved group requirement decisions must be retained.');
        }
        Schema::dropIfExists('study_group_requirement_submissions');
        DB::statement('DROP INDEX study_session_active_requirement');
        DB::statement("CREATE UNIQUE INDEX study_session_active_requirement ON study_sessions (group_id, plan_lecture_id) WHERE status <> 'cancelled'");
        DB::statement('ALTER TABLE study_sessions ALTER COLUMN plan_lecture_id SET NOT NULL');
        Schema::table('study_sessions', fn (Blueprint $table) => $table->dropConstrainedForeignId('group_requirement_id'));
        Schema::dropIfExists('study_group_requirements');
    }
};
