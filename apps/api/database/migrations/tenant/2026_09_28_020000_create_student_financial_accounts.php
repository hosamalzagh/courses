<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('center_settings', function (Blueprint $table): void {
            $table->char('financial_currency', 3)->nullable();
            $table->unsignedInteger('financial_currency_revision')->default(1);
            $table->timestamp('financial_currency_locked_at')->nullable();
        });
        Schema::table('students', fn (Blueprint $table) => $table->unsignedInteger('financial_account_revision')->default(1));
        Schema::create('student_payments', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('student_id')->constrained('students')->restrictOnDelete();
            $table->foreignId('branch_id')->constrained('branches')->restrictOnDelete();
            $table->decimal('amount', 12, 2);
            $table->char('currency', 3);
            $table->string('method', 24);
            $table->date('received_on');
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_name');
            $table->uuid('request_id')->unique();
            $table->char('request_hash', 64);
            $table->timestamp('created_at');
            $table->index(['student_id', 'created_at', 'id']);
            $table->index(['student_id', 'branch_id']);
        });
        DB::statement('ALTER TABLE student_payments ADD CONSTRAINT student_payment_amount_positive CHECK (amount > 0)');
        DB::statement("ALTER TABLE student_payments ADD CONSTRAINT student_payment_method_valid CHECK (method IN ('cash', 'bank_transfer', 'bank_card', 'mobile_wallet'))");
        DB::statement(<<<'SQL'
CREATE FUNCTION preserve_student_payment() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Approved student payments are immutable';
END;
$$ LANGUAGE plpgsql;
SQL);
        DB::statement('CREATE TRIGGER preserve_student_payment BEFORE UPDATE OR DELETE ON student_payments FOR EACH ROW EXECUTE FUNCTION preserve_student_payment()');
    }

    public function down(): void
    {
        if (DB::table('student_payments')->exists()) {
            throw new RuntimeException('Cannot roll back approved student payments.');
        }
        Schema::dropIfExists('student_payments');
        DB::statement('DROP FUNCTION preserve_student_payment()');
        Schema::table('students', fn (Blueprint $table) => $table->dropColumn('financial_account_revision'));
        Schema::table('center_settings', fn (Blueprint $table) => $table->dropColumn(['financial_currency', 'financial_currency_revision', 'financial_currency_locked_at']));
    }
};
