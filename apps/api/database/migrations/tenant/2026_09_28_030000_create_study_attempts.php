<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('study_attempts', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('student_id')->constrained('students')->restrictOnDelete();
            $table->foreignUuid('level_id')->constrained('levels')->restrictOnDelete();
            $table->foreignUuid('plan_version_id')->constrained('study_plan_versions')->restrictOnDelete();
            $table->foreignUuid('current_group_id')->constrained('study_groups')->restrictOnDelete();
            $table->foreignId('branch_id')->constrained('branches')->restrictOnDelete();
            $table->date('joined_on');
            $table->string('status', 20)->default('active');
            $table->unsignedBigInteger('created_by');
            $table->string('created_by_name');
            $table->uuid('request_id')->unique();
            $table->char('request_hash', 64);
            $table->timestamps();
            $table->index(['student_id', 'created_at', 'id']);
            $table->index(['current_group_id', 'status']);
        });
        DB::statement("ALTER TABLE study_attempts ADD CONSTRAINT study_attempt_status_valid CHECK (status IN ('active', 'completed', 'withdrawn'))");
        DB::statement("CREATE UNIQUE INDEX study_attempt_one_current_level ON study_attempts (student_id, level_id) WHERE status = 'active'");
        Schema::create('study_attempt_group_periods', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('attempt_id')->constrained('study_attempts')->restrictOnDelete();
            $table->foreignUuid('group_id')->constrained('study_groups')->restrictOnDelete();
            $table->date('joined_on');
            $table->date('left_on')->nullable();
            $table->timestamp('created_at');
            $table->index(['attempt_id', 'joined_on']);
        });
        DB::statement('CREATE UNIQUE INDEX study_attempt_one_current_group ON study_attempt_group_periods (attempt_id) WHERE left_on IS NULL');
        Schema::create('study_attempt_fees', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('attempt_id')->unique()->constrained('study_attempts')->restrictOnDelete();
            $table->foreignUuid('student_id')->constrained('students')->restrictOnDelete();
            $table->foreignId('branch_id')->constrained('branches')->restrictOnDelete();
            $table->decimal('original_price', 12, 2);
            $table->decimal('discount', 12, 2);
            $table->decimal('net_amount', 12, 2);
            $table->char('currency', 3);
            $table->text('discount_reason')->nullable();
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_name');
            $table->timestamp('created_at');
            $table->index(['student_id', 'branch_id']);
        });
        DB::statement('ALTER TABLE study_attempt_fees ADD CONSTRAINT study_attempt_fee_valid CHECK (original_price >= 0 AND discount >= 0 AND discount <= original_price AND net_amount = original_price - discount AND ((discount = 0 AND discount_reason IS NULL) OR (discount > 0 AND discount_reason IS NOT NULL)))');
        DB::statement(<<<'SQL'
CREATE FUNCTION preserve_study_attempt_fee() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Approved study attempt fees are immutable';
END;
$$ LANGUAGE plpgsql;
SQL);
        DB::statement('CREATE TRIGGER preserve_study_attempt_fee BEFORE UPDATE OR DELETE ON study_attempt_fees FOR EACH ROW EXECUTE FUNCTION preserve_study_attempt_fee()');
    }

    public function down(): void
    {
        if (DB::table('study_attempt_fees')->exists()) {
            throw new RuntimeException('Cannot roll back approved study attempt fees.');
        }
        Schema::dropIfExists('study_attempt_fees');
        DB::statement('DROP FUNCTION preserve_study_attempt_fee()');
        Schema::dropIfExists('study_attempt_group_periods');
        Schema::dropIfExists('study_attempts');
    }
};
