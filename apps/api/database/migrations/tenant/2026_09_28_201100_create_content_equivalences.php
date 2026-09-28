<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('content_equivalences', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('source_plan_version_id')->constrained('study_plan_versions')->restrictOnDelete();
            $table->foreignUuid('target_plan_version_id')->constrained('study_plan_versions')->restrictOnDelete();
            $table->jsonb('source_lecture_ids');
            $table->jsonb('target_lecture_ids');
            $table->text('reason');
            $table->unsignedBigInteger('approved_by_id');
            $table->string('approved_by_name');
            $table->timestamp('approved_at');
            $table->uuid('request_id')->unique();
            $table->char('request_hash', 64);
            $table->char('mapping_hash', 64)->unique();
            $table->index(['approved_at', 'id']);
        });
        DB::statement('ALTER TABLE content_equivalences ADD CONSTRAINT equivalence_distinct_plans CHECK (source_plan_version_id <> target_plan_version_id)');
        DB::statement("ALTER TABLE content_equivalences ADD CONSTRAINT equivalence_whole_sets CHECK (jsonb_typeof(source_lecture_ids) = 'array' AND jsonb_array_length(source_lecture_ids) BETWEEN 1 AND 200 AND jsonb_typeof(target_lecture_ids) = 'array' AND jsonb_array_length(target_lecture_ids) BETWEEN 1 AND 200)");
        DB::unprepared(<<<'SQL'
CREATE FUNCTION protect_approved_content_equivalence() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Approved content equivalence is immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER protect_approved_content_equivalences BEFORE UPDATE OR DELETE ON content_equivalences
FOR EACH ROW EXECUTE FUNCTION protect_approved_content_equivalence();
SQL);
    }

    public function down(): void
    {
        Schema::dropIfExists('content_equivalences');
        DB::statement('DROP FUNCTION IF EXISTS protect_approved_content_equivalence()');
    }
};
