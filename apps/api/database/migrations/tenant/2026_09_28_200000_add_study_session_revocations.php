<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('study_sessions', function (Blueprint $table): void {
            $table->timestampTz('revoked_at')->nullable();
            $table->unsignedBigInteger('revoked_by')->nullable();
            $table->text('revoke_reason')->nullable();
        });
        Schema::table('study_attendance_events', fn (Blueprint $table) => $table->text('reason')->nullable());
    }

    public function down(): void
    {
        Schema::table('study_attendance_events', fn (Blueprint $table) => $table->dropColumn('reason'));
        Schema::table('study_sessions', fn (Blueprint $table) => $table->dropColumn(['revoked_at', 'revoked_by', 'revoke_reason']));
    }
};
