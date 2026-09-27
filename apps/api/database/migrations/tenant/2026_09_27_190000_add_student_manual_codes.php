<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('students', function (Blueprint $table) {
            $table->string('manual_code', 50)->nullable()->unique();
            $table->string('manual_code_number', 50)->nullable()->index();
        });
        Schema::table('center_settings', function (Blueprint $table) {
            $table->boolean('student_code_enabled')->default(false);
            $table->string('student_code_label', 100)->default('الباركود الإضافي');
            $table->unsignedInteger('student_code_revision')->default(1);
        });
    }

    public function down(): void
    {
        Schema::table('students', fn (Blueprint $table) => $table->dropColumn(['manual_code', 'manual_code_number']));
        Schema::table('center_settings', fn (Blueprint $table) => $table->dropColumn(['student_code_enabled', 'student_code_label', 'student_code_revision']));
    }
};
