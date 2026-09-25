<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('center_audit_logs', function (Blueprint $table) {
            $table->unsignedBigInteger('source_event_id')->nullable()->unique();
        });
    }

    public function down(): void
    {
        Schema::table('center_audit_logs', fn (Blueprint $table) => $table->dropColumn('source_event_id'));
    }
};
