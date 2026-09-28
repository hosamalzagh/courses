<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('study_fee_adjustment_submissions', function (Blueprint $table): void {
            $table->uuid('request_id')->primary();
            $table->foreignUuid('student_id')->constrained('students')->restrictOnDelete();
            $table->foreignUuid('fee_id')->constrained('study_attempt_fees')->restrictOnDelete();
            $table->string('kind', 20);
            $table->char('request_hash', 64);
            $table->unsignedBigInteger('actor_id');
            $table->timestampTz('created_at');
        });
        DB::statement("ALTER TABLE study_fee_adjustment_submissions ADD CONSTRAINT study_fee_adjustment_submission_kind CHECK (kind IN ('settle', 'correct'))");

        Schema::create('study_fee_adjustments', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('submission_id')->constrained('study_fee_adjustment_submissions', 'request_id')->restrictOnDelete();
            $table->unsignedSmallInteger('sequence');
            $table->foreignUuid('student_id')->constrained('students')->restrictOnDelete();
            $table->foreignUuid('fee_id')->constrained('study_attempt_fees')->restrictOnDelete();
            $table->foreignId('branch_id')->constrained('branches')->restrictOnDelete();
            $table->string('kind', 20);
            $table->decimal('amount_delta', 12, 2);
            $table->decimal('before_due', 12, 2);
            $table->decimal('after_due', 12, 2);
            $table->uuid('reverses_id')->nullable()->unique();
            $table->uuid('replaces_id')->nullable();
            $table->text('reason');
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_name');
            $table->timestampTz('created_at');
            $table->unique(['submission_id', 'sequence']);
            $table->index(['fee_id', 'created_at']);
        });
        Schema::table('study_fee_adjustments', function (Blueprint $table): void {
            $table->foreign('reverses_id')->references('id')->on('study_fee_adjustments')->restrictOnDelete();
            $table->foreign('replaces_id')->references('id')->on('study_fee_adjustments')->restrictOnDelete();
        });
        DB::statement("ALTER TABLE study_fee_adjustments ADD CONSTRAINT study_fee_adjustment_kind CHECK (kind IN ('settlement', 'reversal'))");
        DB::statement('ALTER TABLE study_fee_adjustments ADD CONSTRAINT study_fee_adjustment_amounts CHECK (before_due >= 0 AND after_due >= 0 AND after_due = before_due + amount_delta)');
        DB::statement('ALTER TABLE study_fee_adjustments ADD CONSTRAINT study_fee_adjustment_reason CHECK (length(trim(reason)) > 0)');

        DB::unprepared(<<<'SQL'
CREATE FUNCTION preserve_study_fee_adjustment() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Approved study fee adjustments are immutable';
END;
$$ LANGUAGE plpgsql;
SQL);
        foreach (['study_fee_adjustment_submissions', 'study_fee_adjustments'] as $table) {
            DB::statement("CREATE TRIGGER preserve_{$table} BEFORE UPDATE OR DELETE ON {$table} FOR EACH ROW EXECUTE FUNCTION preserve_study_fee_adjustment()");
        }
    }

    public function down(): void
    {
        if (DB::table('study_fee_adjustments')->exists()) {
            throw new RuntimeException('Cannot roll back approved study fee adjustments.');
        }
        Schema::dropIfExists('study_fee_adjustments');
        Schema::dropIfExists('study_fee_adjustment_submissions');
        DB::statement('DROP FUNCTION preserve_study_fee_adjustment()');
    }
};
