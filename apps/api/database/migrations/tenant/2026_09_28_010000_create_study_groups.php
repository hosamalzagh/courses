<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('courses', function (Blueprint $table): void {
            $table->unsignedTinyInteger('completion_threshold')->default(80);
            $table->unsignedInteger('completion_revision')->default(1);
        });
        Schema::table('stages', function (Blueprint $table): void {
            $table->unsignedTinyInteger('completion_threshold')->nullable();
            $table->unsignedInteger('completion_revision')->default(1);
        });
        Schema::table('levels', function (Blueprint $table): void {
            $table->unsignedTinyInteger('completion_threshold')->nullable();
            $table->unsignedInteger('completion_revision')->default(1);
        });
        Schema::create('study_groups', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('level_id')->constrained('levels')->restrictOnDelete();
            $table->foreignUuid('plan_version_id')->constrained('study_plan_versions')->restrictOnDelete();
            $table->string('name');
            $table->string('status', 20)->default('waiting');
            $table->decimal('approved_price', 12, 2);
            $table->unsignedTinyInteger('completion_threshold')->nullable();
            $table->unsignedInteger('revision')->default(1);
            $table->timestamp('started_at')->nullable();
            $table->unsignedBigInteger('created_by');
            $table->uuid('request_id')->unique();
            $table->char('request_hash', 64);
            $table->timestamps();
            $table->index(['level_id', 'created_at']);
            $table->index(['created_at', 'id']);
        });
        Schema::create('study_group_instructors', function (Blueprint $table): void {
            $table->foreignUuid('group_id')->constrained('study_groups')->restrictOnDelete();
            $table->foreignUuid('instructor_id')->constrained('instructors')->restrictOnDelete();
            $table->primary(['group_id', 'instructor_id']);
        });
        DB::statement("ALTER TABLE study_groups ADD CONSTRAINT study_group_status_valid CHECK (status IN ('waiting', 'started', 'completed'))");
        DB::statement('ALTER TABLE study_groups ADD CONSTRAINT study_group_price_valid CHECK (approved_price >= 0)');
        foreach (['courses', 'stages', 'levels', 'study_groups'] as $table) {
            DB::statement("ALTER TABLE {$table} ADD CONSTRAINT {$table}_completion_threshold_valid CHECK (completion_threshold BETWEEN 1 AND 100)");
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('study_group_instructors');
        Schema::dropIfExists('study_groups');
        foreach (['levels', 'stages', 'courses'] as $table) {
            Schema::table($table, fn (Blueprint $schema) => $schema->dropColumn(['completion_threshold', 'completion_revision']));
        }
    }
};
