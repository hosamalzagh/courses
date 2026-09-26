<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('courses', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignId('branch_id')->constrained('branches')->restrictOnDelete();
            $table->string('name');
            $table->timestamps();
            $table->index(['branch_id', 'created_at']);
        });
        Schema::create('stages', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('course_id')->constrained('courses')->restrictOnDelete();
            $table->string('name');
            $table->timestamps();
        });
        Schema::create('levels', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('stage_id')->constrained('stages')->restrictOnDelete();
            $table->string('name');
            $table->timestamps();
        });
        Schema::create('study_plan_versions', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('level_id')->constrained('levels')->restrictOnDelete();
            $table->unsignedInteger('version');
            $table->unsignedInteger('revision')->default(1);
            $table->timestamp('used_at')->nullable();
            $table->timestamps();
            $table->unique(['level_id', 'version']);
        });
        Schema::create('plan_lectures', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('plan_version_id')->constrained('study_plan_versions')->restrictOnDelete();
            $table->unsignedInteger('number');
            $table->text('content');
            $table->string('title')->nullable();
            $table->decimal('planned_hours', 6, 2);
            $table->unique(['plan_version_id', 'number']);
        });
        Schema::create('curriculum_submissions', function (Blueprint $table): void {
            $table->uuid('request_id')->primary();
            $table->unsignedBigInteger('created_by');
            $table->foreignId('branch_id')->constrained('branches')->restrictOnDelete();
            $table->string('kind');
            $table->uuid('record_id');
            $table->char('request_hash', 64);
            $table->timestamp('created_at');
        });
        DB::statement('ALTER TABLE plan_lectures ADD CONSTRAINT whole_positive_lecture CHECK (number > 0 AND planned_hours > 0)');
        DB::unprepared(<<<'SQL'
CREATE FUNCTION protect_used_plan_lecture() RETURNS trigger AS $$
DECLARE plan_id uuid;
DECLARE already_used timestamp;
BEGIN
    plan_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.plan_version_id ELSE NEW.plan_version_id END;
    SELECT used_at INTO already_used FROM study_plan_versions WHERE id = plan_id FOR UPDATE;
    IF already_used IS NOT NULL THEN RAISE EXCEPTION 'Used study plan is immutable'; END IF;
    IF TG_OP = 'UPDATE' AND OLD.plan_version_id <> NEW.plan_version_id THEN
        SELECT used_at INTO already_used FROM study_plan_versions WHERE id = OLD.plan_version_id FOR UPDATE;
        IF already_used IS NOT NULL THEN RAISE EXCEPTION 'Used study plan is immutable'; END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER protect_used_plan_lectures BEFORE INSERT OR UPDATE OR DELETE ON plan_lectures FOR EACH ROW EXECUTE FUNCTION protect_used_plan_lecture();
CREATE FUNCTION protect_used_plan_version() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' AND OLD.used_at IS NOT NULL THEN RAISE EXCEPTION 'Used study plan is immutable'; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.level_id <> OLD.level_id OR NEW.version <> OLD.version OR (OLD.used_at IS NOT NULL AND (NEW.used_at IS DISTINCT FROM OLD.used_at OR NEW.revision <> OLD.revision))) THEN
        RAISE EXCEPTION 'Study plan identity and used content are immutable';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER protect_used_plan_versions BEFORE UPDATE OR DELETE ON study_plan_versions FOR EACH ROW EXECUTE FUNCTION protect_used_plan_version();
SQL);
    }

    public function down(): void
    {
        Schema::dropIfExists('curriculum_submissions');
        Schema::dropIfExists('plan_lectures');
        Schema::dropIfExists('study_plan_versions');
        Schema::dropIfExists('levels');
        Schema::dropIfExists('stages');
        Schema::dropIfExists('courses');
        DB::statement('DROP FUNCTION IF EXISTS protect_used_plan_lecture()');
        DB::statement('DROP FUNCTION IF EXISTS protect_used_plan_version()');
    }
};
