<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('curriculum_course_copies', function (Blueprint $table): void {
            $table->uuid('request_id')->primary();
            $table->uuid('source_course_id');
            $table->uuid('copied_course_id')->unique();
            $table->unsignedBigInteger('source_branch_id');
            $table->unsignedBigInteger('target_branch_id');
            $table->string('source_course_name');
            $table->string('source_branch_name');
            $table->char('request_hash', 64);
            $table->char('snapshot_hash', 64);
            $table->unsignedBigInteger('created_by');
            $table->timestamp('created_at');
            $table->index(['target_branch_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('curriculum_course_copies');
    }
};
