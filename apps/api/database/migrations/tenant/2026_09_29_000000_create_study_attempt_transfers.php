<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('study_attempt_transfers', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('attempt_id')->constrained('study_attempts')->restrictOnDelete();
            $table->foreignId('from_branch_id')->constrained('branches')->restrictOnDelete();
            $table->foreignUuid('from_level_id')->constrained('levels')->restrictOnDelete();
            $table->foreignUuid('from_plan_version_id')->constrained('study_plan_versions')->restrictOnDelete();
            $table->foreignUuid('from_group_id')->nullable()->constrained('study_groups')->restrictOnDelete();
            $table->foreignId('to_branch_id')->constrained('branches')->restrictOnDelete();
            $table->foreignUuid('to_level_id')->constrained('levels')->restrictOnDelete();
            $table->foreignUuid('to_plan_version_id')->constrained('study_plan_versions')->restrictOnDelete();
            $table->foreignUuid('to_group_id')->constrained('study_groups')->restrictOnDelete();
            $table->date('transferred_on');
            $table->jsonb('approval_ids');
            $table->unsignedSmallInteger('credited_count');
            $table->unsignedSmallInteger('required_count');
            $table->text('reason');
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_name');
            $table->uuid('request_id')->unique();
            $table->char('request_hash', 64);
            $table->timestamp('created_at');
            $table->index(['attempt_id', 'transferred_on', 'created_at']);
        });
        DB::statement('ALTER TABLE study_attempt_transfers ADD CONSTRAINT study_transfer_distinct_group CHECK (from_group_id IS DISTINCT FROM to_group_id)');
    }

    public function down(): void
    {
        if (DB::table('study_attempt_transfers')->exists()) {
            throw new RuntimeException('Cannot roll back recorded study transfers.');
        }
        Schema::dropIfExists('study_attempt_transfers');
    }
};
