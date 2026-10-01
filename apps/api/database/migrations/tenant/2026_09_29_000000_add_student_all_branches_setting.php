<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('center_settings', function (Blueprint $table): void {
            $table->boolean('student_all_branches_enabled')->default(false);
            $table->unsignedInteger('student_all_branches_revision')->default(1);
        });
    }

    public function down(): void
    {
        Schema::table('center_settings', fn (Blueprint $table) => $table->dropColumn(['student_all_branches_enabled', 'student_all_branches_revision']));
    }
};
