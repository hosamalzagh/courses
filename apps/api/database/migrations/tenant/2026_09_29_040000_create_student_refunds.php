<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('student_refund_submissions', function (Blueprint $table): void {
            $table->uuid('request_id')->primary();
            $table->foreignUuid('student_id')->constrained('students')->restrictOnDelete();
            $table->foreignUuid('payment_id')->constrained('student_payments')->restrictOnDelete();
            $table->string('kind', 12);
            $table->char('request_hash', 64);
            $table->unsignedBigInteger('actor_id');
            $table->jsonb('refund_ids');
            $table->timestamp('created_at');
        });
        DB::statement("ALTER TABLE student_refund_submissions ADD CONSTRAINT student_refund_submission_kind CHECK (kind IN ('refund', 'correct'))");

        Schema::create('student_refunds', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('student_id')->constrained('students')->restrictOnDelete();
            $table->foreignUuid('payment_id')->constrained('student_payments')->restrictOnDelete();
            $table->foreignId('branch_id')->constrained('branches')->restrictOnDelete();
            $table->decimal('amount', 12, 2);
            $table->char('currency', 3);
            $table->date('refunded_on');
            $table->text('reason');
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_name');
            $table->foreignUuid('submission_id')->constrained('student_refund_submissions', 'request_id')->restrictOnDelete();
            $table->timestamp('created_at');
            $table->index(['payment_id', 'created_at', 'id']);
            $table->index(['student_id', 'branch_id']);
            $table->index('submission_id');
        });
        DB::statement('ALTER TABLE student_refunds ADD CONSTRAINT student_refund_amount_positive CHECK (amount > 0)');
        DB::statement('ALTER TABLE student_refunds ADD CONSTRAINT student_refund_reason CHECK (length(trim(reason)) > 0)');

        Schema::create('student_refund_reversals', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('refund_id')->unique()->constrained('student_refunds')->restrictOnDelete();
            $table->foreignUuid('student_id')->constrained('students')->restrictOnDelete();
            $table->text('reason');
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_name');
            $table->foreignUuid('submission_id')->constrained('student_refund_submissions', 'request_id')->restrictOnDelete();
            $table->timestamp('created_at');
        });
        DB::statement('ALTER TABLE student_refund_reversals ADD CONSTRAINT student_refund_reversal_reason CHECK (length(trim(reason)) > 0)');
        DB::statement(<<<'SQL'
CREATE FUNCTION preserve_student_refund_entry() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Approved student refund entries are immutable';
END;
$$ LANGUAGE plpgsql;
SQL);
        foreach (['student_refund_submissions', 'student_refunds', 'student_refund_reversals'] as $table) {
            DB::statement("CREATE TRIGGER preserve_{$table} BEFORE UPDATE OR DELETE ON {$table} FOR EACH ROW EXECUTE FUNCTION preserve_student_refund_entry()");
        }
    }

    public function down(): void
    {
        if (DB::table('student_refunds')->exists() || DB::table('student_refund_reversals')->exists()) {
            throw new RuntimeException('Cannot roll back approved student refunds.');
        }
        Schema::dropIfExists('student_refund_reversals');
        Schema::dropIfExists('student_refunds');
        Schema::dropIfExists('student_refund_submissions');
        DB::statement('DROP FUNCTION preserve_student_refund_entry()');
    }
};
