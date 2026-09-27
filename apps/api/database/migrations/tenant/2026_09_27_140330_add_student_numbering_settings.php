<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('center_settings', function (Blueprint $table): void {
            $table->unsignedBigInteger('student_number_start')->default(1);
            $table->unsignedInteger('student_number_revision')->default(1);
        });
    }

    public function down(): void
    {
        Schema::table('center_settings', function (Blueprint $table): void {
            $table->dropColumn(['student_number_start', 'student_number_revision']);
        });
    }
};
