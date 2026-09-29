<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('study_group_requirement_equivalences', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('required_requirement_id')->constrained('study_group_requirements')->restrictOnDelete();
            $table->foreignUuid('candidate_requirement_id')->constrained('study_group_requirements')->restrictOnDelete();
            $table->foreignUuid('required_group_id')->constrained('study_groups')->restrictOnDelete();
            $table->foreignUuid('candidate_group_id')->constrained('study_groups')->restrictOnDelete();
            $table->unsignedBigInteger('approved_by');
            $table->string('approved_by_name');
            $table->text('reason');
            $table->timestampTz('approved_at');
            $table->unsignedInteger('revision')->default(1);
            $table->unsignedBigInteger('revoked_by')->nullable();
            $table->string('revoked_by_name')->nullable();
            $table->text('revoke_reason')->nullable();
            $table->timestampTz('revoked_at')->nullable();
            $table->uuid('request_id')->unique();
            $table->char('request_hash', 64);
            $table->uuid('revoke_request_id')->nullable()->unique();
            $table->char('revoke_request_hash', 64)->nullable();
            $table->index(['required_group_id', 'revoked_at']);
            $table->index(['candidate_group_id', 'revoked_at']);
        });
        DB::statement('CREATE UNIQUE INDEX active_group_requirement_equivalence ON study_group_requirement_equivalences (required_requirement_id, candidate_requirement_id) WHERE revoked_at IS NULL');
        DB::statement('ALTER TABLE study_group_requirement_equivalences ADD CONSTRAINT distinct_group_requirement_equivalence CHECK (required_requirement_id <> candidate_requirement_id AND required_group_id <> candidate_group_id)');
    }

    public function down(): void
    {
        if (DB::table('study_group_requirement_equivalences')->exists()) {
            throw new RuntimeException('Cannot roll back approved group requirement equivalences.');
        }
        Schema::dropIfExists('study_group_requirement_equivalences');
    }
};
