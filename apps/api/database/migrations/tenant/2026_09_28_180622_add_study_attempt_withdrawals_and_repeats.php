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
            $table->unsignedInteger('revision')->default(1);
            $table->foreignUuid('repeated_from_attempt_id')->nullable()->constrained('study_attempts')->restrictOnDelete();
            $table->unique('repeated_from_attempt_id');
        });
        Schema::create('study_attempt_withdrawals', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('attempt_id')->unique()->constrained('study_attempts')->restrictOnDelete();
            $table->date('withdrawn_on');
            $table->text('reason');
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_name');
            $table->uuid('request_id')->unique();
            $table->char('request_hash', 64);
            $table->timestamp('created_at');
        });
        DB::statement(<<<'SQL'
CREATE FUNCTION preserve_study_attempt_withdrawal() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Approved study attempt withdrawals are immutable';
END;
$$ LANGUAGE plpgsql;
SQL);
        DB::statement('CREATE TRIGGER preserve_study_attempt_withdrawal BEFORE UPDATE OR DELETE ON study_attempt_withdrawals FOR EACH ROW EXECUTE FUNCTION preserve_study_attempt_withdrawal()');
    }

    public function down(): void
    {
        if (DB::table('study_attempt_withdrawals')->exists()
            || DB::table('study_attempts')->whereNotNull('repeated_from_attempt_id')->exists()) {
            throw new RuntimeException('Cannot roll back approved study attempt withdrawals or repeats.');
        }
        Schema::dropIfExists('study_attempt_withdrawals');
        DB::statement('DROP FUNCTION preserve_study_attempt_withdrawal()');
        Schema::table('study_attempts', function (Blueprint $table): void {
            $table->dropUnique(['repeated_from_attempt_id']);
            $table->dropConstrainedForeignId('repeated_from_attempt_id');
            $table->dropColumn('revision');
        });
    }
};
