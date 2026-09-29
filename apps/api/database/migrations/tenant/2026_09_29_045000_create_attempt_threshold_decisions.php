<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('study_threshold_submissions', function (Blueprint $table): void {
            $table->uuid('request_id')->primary();
            $table->uuid('group_id');
            $table->unsignedBigInteger('actor_id');
            $table->char('request_hash', 64);
            $table->jsonb('result');
            $table->timestampTz('created_at');
        });
        Schema::create('study_attempt_threshold_history', function (Blueprint $table): void {
            $table->foreignUuid('request_id')->references('request_id')->on('study_threshold_submissions')->restrictOnDelete();
            $table->uuid('attempt_id');
            $table->unsignedSmallInteger('before_threshold');
            $table->unsignedSmallInteger('after_threshold');
            $table->unsignedSmallInteger('covered_count');
            $table->unsignedSmallInteger('open_credited_count');
            $table->unsignedSmallInteger('required_count');
            $table->unsignedSmallInteger('before_needed');
            $table->unsignedSmallInteger('after_needed');
            $table->boolean('before_eligible');
            $table->boolean('after_eligible');
            $table->boolean('before_provisional');
            $table->boolean('after_provisional');
            $table->timestampTz('created_at');
            $table->primary(['request_id', 'attempt_id']);
            $table->index(['attempt_id', 'created_at']);
        });
    }

    public function down(): void
    {
        if (DB::table('study_threshold_submissions')->exists()
            || DB::table('study_attempt_threshold_history')->exists()) {
            throw new RuntimeException('Cannot roll back recorded study threshold decisions.');
        }
        Schema::dropIfExists('study_attempt_threshold_history');
        Schema::dropIfExists('study_threshold_submissions');
    }
};
