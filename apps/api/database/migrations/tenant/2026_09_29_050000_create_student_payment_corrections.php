<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('student_payment_correction_submissions', function (Blueprint $table): void {
            $table->uuid('request_id')->primary();
            $table->foreignUuid('student_id')->constrained('students')->restrictOnDelete();
            $table->foreignUuid('payment_id')->constrained('student_payments')->restrictOnDelete();
            $table->char('request_hash', 64);
            $table->unsignedBigInteger('actor_id');
            $table->timestampTz('created_at');
        });
        Schema::create('student_payment_reversals', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('payment_id')->constrained('student_payments')->restrictOnDelete();
            $table->uuid('prior_replacement_id')->nullable()->unique();
            $table->text('reason');
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_name');
            $table->foreignUuid('submission_id')->unique()->constrained('student_payment_correction_submissions', 'request_id')->restrictOnDelete();
            $table->timestampTz('created_at');
            $table->index(['payment_id', 'created_at', 'id']);
        });
        DB::statement('CREATE UNIQUE INDEX student_payment_initial_reversal_unique ON student_payment_reversals (payment_id) WHERE prior_replacement_id IS NULL');
        DB::statement('ALTER TABLE student_payment_reversals ADD CONSTRAINT student_payment_reversal_reason CHECK (length(trim(reason)) > 0)');
        Schema::create('student_payment_replacements', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('payment_id')->constrained('student_payments')->restrictOnDelete();
            $table->foreignUuid('reversal_id')->unique()->constrained('student_payment_reversals')->restrictOnDelete();
            $table->decimal('amount', 12, 2);
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_name');
            $table->foreignUuid('submission_id')->unique()->constrained('student_payment_correction_submissions', 'request_id')->restrictOnDelete();
            $table->timestampTz('created_at');
            $table->index(['payment_id', 'created_at', 'id']);
        });
        DB::statement('ALTER TABLE student_payment_replacements ADD CONSTRAINT student_payment_replacement_amount_nonnegative CHECK (amount >= 0)');
        Schema::table('student_payment_reversals', function (Blueprint $table): void {
            $table->foreign('prior_replacement_id')->references('id')->on('student_payment_replacements')->restrictOnDelete();
        });
        Schema::create('student_payment_correction_allocations', function (Blueprint $table): void {
            $table->id();
            $table->foreignUuid('payment_reversal_id')->constrained('student_payment_reversals')->restrictOnDelete();
            $table->foreignUuid('original_allocation_id')->unique()->constrained('student_payment_allocations')->restrictOnDelete();
            $table->foreignUuid('allocation_reversal_id')->unique()->constrained('student_payment_allocation_reversals')->restrictOnDelete();
            $table->foreignUuid('replacement_allocation_id')->nullable()->constrained('student_payment_allocations')->restrictOnDelete();
            $table->unique('replacement_allocation_id', 'spca_replacement_unique');
            $table->decimal('amount_before', 12, 2);
            $table->decimal('amount_after', 12, 2);
            $table->timestampTz('created_at');
            $table->index('payment_reversal_id');
        });
        DB::statement('ALTER TABLE student_payment_correction_allocations ADD CONSTRAINT student_payment_correction_allocation_amounts CHECK (amount_before > 0 AND amount_after >= 0)');
        DB::statement('ALTER TABLE student_allocation_submissions DROP CONSTRAINT student_allocation_submission_kind');
        DB::statement("ALTER TABLE student_allocation_submissions ADD CONSTRAINT student_allocation_submission_kind CHECK (kind IN ('allocate', 'reverse', 'correct', 'payment_correct'))");
        DB::statement(<<<'SQL'
CREATE FUNCTION preserve_student_payment_correction_entry() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Approved student payment corrections are immutable';
END;
$$ LANGUAGE plpgsql;
SQL);
        foreach (['student_payment_correction_submissions', 'student_payment_reversals',
            'student_payment_replacements', 'student_payment_correction_allocations'] as $table) {
            DB::statement("CREATE TRIGGER preserve_{$table} BEFORE UPDATE OR DELETE ON {$table} FOR EACH ROW EXECUTE FUNCTION preserve_student_payment_correction_entry()");
        }
    }

    public function down(): void
    {
        if (DB::table('student_payment_reversals')->exists()
            || DB::table('student_payment_replacements')->exists()
            || DB::table('student_payment_correction_allocations')->exists()) {
            throw new RuntimeException('Cannot roll back approved student payment corrections.');
        }
        DB::statement('ALTER TABLE student_allocation_submissions DROP CONSTRAINT student_allocation_submission_kind');
        DB::statement("ALTER TABLE student_allocation_submissions ADD CONSTRAINT student_allocation_submission_kind CHECK (kind IN ('allocate', 'reverse', 'correct'))");
        Schema::dropIfExists('student_payment_correction_allocations');
        Schema::table('student_payment_reversals', fn (Blueprint $table) => $table->dropForeign(['prior_replacement_id']));
        Schema::dropIfExists('student_payment_replacements');
        Schema::dropIfExists('student_payment_reversals');
        Schema::dropIfExists('student_payment_correction_submissions');
        DB::statement('DROP FUNCTION preserve_student_payment_correction_entry()');
    }
};
