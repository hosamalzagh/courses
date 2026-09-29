<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('study_attempt_group_periods', function (Blueprint $table): void {
            $table->jsonb('required_credit_ids')->nullable();
        });
    }

    public function down(): void
    {
        if (DB::table('study_attempt_group_periods')->whereNotNull('required_credit_ids')->exists()) {
            throw new RuntimeException('Cannot discard frozen study period requirements.');
        }
        Schema::table('study_attempt_group_periods', function (Blueprint $table): void {
            $table->dropColumn('required_credit_ids');
        });
    }
};
