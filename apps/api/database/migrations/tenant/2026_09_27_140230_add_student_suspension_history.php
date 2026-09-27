<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('students', function (Blueprint $table) {
            $table->string('status', 20)->default('active');
            $table->unsignedInteger('status_revision')->default(1);
        });
        DB::statement("ALTER TABLE students ADD CONSTRAINT students_status_check CHECK (status IN ('active', 'suspended'))");
        Schema::create('student_suspensions', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('student_id')->constrained('students', 'id');
            $table->uuid('suspended_request_id')->unique();
            $table->char('suspended_request_hash', 64);
            $table->unsignedBigInteger('suspended_by');
            $table->string('suspended_by_name');
            $table->text('suspended_reason');
            $table->timestampTz('suspended_at', 6);
            $table->uuid('lifted_request_id')->nullable()->unique();
            $table->char('lifted_request_hash', 64)->nullable();
            $table->unsignedBigInteger('lifted_by')->nullable();
            $table->string('lifted_by_name')->nullable();
            $table->text('lifted_reason')->nullable();
            $table->timestampTz('lifted_at', 6)->nullable();
            $table->index(['student_id', 'suspended_at', 'id']);
        });
        DB::statement('CREATE UNIQUE INDEX student_suspensions_one_open ON student_suspensions (student_id) WHERE lifted_at IS NULL');
        DB::statement('ALTER TABLE student_suspensions ADD CONSTRAINT student_suspensions_dates_check CHECK (lifted_at IS NULL OR lifted_at >= suspended_at)');
    }

    public function down(): void
    {
        Schema::dropIfExists('student_suspensions');
        DB::statement('ALTER TABLE students DROP CONSTRAINT students_status_check');
        Schema::table('students', fn (Blueprint $table) => $table->dropColumn(['status', 'status_revision']));
    }
};
