<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('study_attempts', function (Blueprint $table): void {
            $table->foreignUuid('current_group_id')->nullable()->change();
        });
        Schema::create('study_attempt_waitlists', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('attempt_id')->constrained('study_attempts')->restrictOnDelete();
            $table->foreignUuid('from_group_id')->constrained('study_groups')->restrictOnDelete();
            $table->foreignUuid('to_group_id')->nullable()->constrained('study_groups')->restrictOnDelete();
            $table->foreignId('branch_id')->constrained('branches')->restrictOnDelete();
            $table->date('entered_on');
            $table->date('left_on')->nullable();
            $table->text('reason');
            $table->unsignedBigInteger('entered_by');
            $table->string('entered_by_name');
            $table->unsignedBigInteger('left_by')->nullable();
            $table->string('left_by_name')->nullable();
            $table->uuid('entry_request_id')->unique();
            $table->char('entry_request_hash', 64);
            $table->uuid('exit_request_id')->nullable()->unique();
            $table->char('exit_request_hash', 64)->nullable();
            $table->timestamps();
            $table->index(['attempt_id', 'entered_on']);
        });
        DB::statement('CREATE UNIQUE INDEX study_attempt_one_open_waitlist ON study_attempt_waitlists (attempt_id) WHERE left_on IS NULL');
        DB::statement('ALTER TABLE study_attempt_waitlists ADD CONSTRAINT study_attempt_waitlist_dates_valid CHECK (left_on IS NULL OR left_on >= entered_on)');
    }

    public function down(): void
    {
        Schema::dropIfExists('study_attempt_waitlists');
        if (DB::table('study_attempts')->whereNull('current_group_id')->exists()) {
            throw new RuntimeException('Cannot remove active level waitlists.');
        }
        Schema::table('study_attempts', function (Blueprint $table): void {
            $table->foreignUuid('current_group_id')->nullable(false)->change();
        });
    }
};
