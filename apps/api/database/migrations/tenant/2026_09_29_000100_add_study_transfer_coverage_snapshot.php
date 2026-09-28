<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('study_attempt_transfers', function (Blueprint $table): void {
            $table->jsonb('credited_lectures')->nullable();
            $table->jsonb('missing_lectures')->nullable();
        });
    }

    public function down(): void
    {
        if (DB::table('study_attempt_transfers')->exists()) {
            throw new RuntimeException('Cannot roll back recorded transfer coverage snapshots.');
        }
        Schema::table('study_attempt_transfers', fn (Blueprint $table) => $table->dropColumn(['credited_lectures', 'missing_lectures']));
    }
};
