<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('study_group_requirement_impacts', function (Blueprint $table): void {
            $table->uuid('request_id');
            $table->foreignUuid('group_id')->constrained('study_groups')->restrictOnDelete();
            $table->foreignUuid('attempt_id')->constrained('study_attempts')->restrictOnDelete();
            $table->unsignedSmallInteger('completion_threshold');
            $table->unsignedSmallInteger('before_covered');
            $table->unsignedSmallInteger('after_covered');
            $table->unsignedSmallInteger('before_required');
            $table->unsignedSmallInteger('after_required');
            $table->decimal('before_percentage', 5, 2);
            $table->decimal('after_percentage', 5, 2);
            $table->unsignedSmallInteger('before_needed');
            $table->unsignedSmallInteger('after_needed');
            $table->boolean('before_eligible');
            $table->boolean('after_eligible');
            $table->timestampTz('created_at');
            $table->primary(['request_id', 'attempt_id']);
            $table->index(['group_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('study_group_requirement_impacts');
    }
};
