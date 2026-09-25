<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::connection('central')->table('center_audit_outbox', function (Blueprint $table) {
            $table->timestamp('next_attempt_at')->nullable()->index();
        });
    }

    public function down(): void
    {
        Schema::connection('central')->table('center_audit_outbox', fn (Blueprint $table) => $table->dropColumn('next_attempt_at'));
    }
};
