<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('student_allocation_submissions', function (Blueprint $table): void {
            $table->uuid('request_id')->primary();
            $table->foreignUuid('student_id')->constrained('students')->restrictOnDelete();
            $table->string('kind', 20);
            $table->char('request_hash', 64);
            $table->unsignedBigInteger('actor_id');
            $table->jsonb('allocation_ids');
            $table->timestampTz('created_at');
        });
        DB::statement("ALTER TABLE student_allocation_submissions ADD CONSTRAINT student_allocation_submission_kind CHECK (kind IN ('allocate', 'reverse'))");

        Schema::create('student_payment_allocations', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('student_id')->constrained('students')->restrictOnDelete();
            $table->foreignUuid('payment_id')->constrained('student_payments')->restrictOnDelete();
            $table->foreignUuid('fee_id')->constrained('study_attempt_fees')->restrictOnDelete();
            $table->foreignId('source_branch_id')->constrained('branches')->restrictOnDelete();
            $table->foreignId('target_branch_id')->constrained('branches')->restrictOnDelete();
            $table->decimal('amount', 12, 2);
            $table->char('currency', 3);
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_name');
            $table->foreignUuid('submission_id')->constrained('student_allocation_submissions', 'request_id')->restrictOnDelete();
            $table->timestampTz('created_at');
            $table->index(['payment_id', 'created_at']);
            $table->index(['fee_id', 'created_at']);
            $table->index(['student_id', 'created_at']);
        });
        DB::statement('ALTER TABLE student_payment_allocations ADD CONSTRAINT student_payment_allocation_positive CHECK (amount > 0)');

        Schema::create('student_payment_allocation_reversals', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('allocation_id')->unique()->constrained('student_payment_allocations')->restrictOnDelete();
            $table->foreignUuid('student_id')->constrained('students')->restrictOnDelete();
            $table->text('reason');
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_name');
            $table->foreignUuid('submission_id')->constrained('student_allocation_submissions', 'request_id')->restrictOnDelete();
            $table->timestampTz('created_at');
        });
        DB::statement("ALTER TABLE student_payment_allocation_reversals ADD CONSTRAINT student_allocation_reversal_reason CHECK (length(trim(reason)) > 0)");

        DB::unprepared(<<<'SQL'
CREATE FUNCTION preserve_student_allocation_entry() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Approved student allocation entries are immutable';
END;
$$ LANGUAGE plpgsql;
SQL);
        foreach (['student_allocation_submissions', 'student_payment_allocations', 'student_payment_allocation_reversals'] as $table) {
            DB::statement("CREATE TRIGGER preserve_{$table} BEFORE UPDATE OR DELETE ON {$table} FOR EACH ROW EXECUTE FUNCTION preserve_student_allocation_entry()");
        }
    }

    public function down(): void
    {
        if (DB::table('student_payment_allocations')->exists()
            || DB::table('student_payment_allocation_reversals')->exists()) {
            throw new RuntimeException('Cannot roll back approved student allocations.');
        }
        Schema::dropIfExists('student_payment_allocation_reversals');
        Schema::dropIfExists('student_payment_allocations');
        Schema::dropIfExists('student_allocation_submissions');
        DB::statement('DROP FUNCTION preserve_student_allocation_entry()');
    }
};
