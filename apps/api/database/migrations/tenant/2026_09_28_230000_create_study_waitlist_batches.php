<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('study_waitlist_batches', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_name');
            $table->string('selection_mode', 12);
            $table->jsonb('scope');
            $table->date('entered_on');
            $table->text('reason');
            $table->unsignedInteger('item_count')->default(0);
            $table->timestamps();
        });
        DB::statement("ALTER TABLE study_waitlist_batches ADD CONSTRAINT study_waitlist_batch_mode CHECK (selection_mode IN ('selected', 'all'))");

        Schema::create('study_waitlist_batch_items', function (Blueprint $table): void {
            $table->bigIncrements('id');
            $table->foreignUuid('batch_id')->constrained('study_waitlist_batches')->restrictOnDelete();
            $table->uuid('attempt_id');
            $table->uuid('student_id');
            $table->unsignedBigInteger('branch_id');
            $table->uuid('group_id');
            $table->unsignedInteger('attempt_revision');
            $table->string('student_name');
            $table->unsignedBigInteger('student_number');
            $table->string('status', 12)->default('pending');
            $table->string('result_reason')->nullable();
            $table->uuid('waitlist_id')->nullable();
            $table->timestamp('processed_at')->nullable();
            $table->unique(['batch_id', 'attempt_id']);
            $table->index(['batch_id', 'status', 'id']);
        });
        DB::statement("ALTER TABLE study_waitlist_batch_items ADD CONSTRAINT study_waitlist_batch_item_status CHECK (status IN ('pending', 'moved', 'skipped'))");
    }

    public function down(): void
    {
        Schema::dropIfExists('study_waitlist_batch_items');
        Schema::dropIfExists('study_waitlist_batches');
    }
};
