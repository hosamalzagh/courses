<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Existing profiles retain their previous eligibility for center discovery.
        // The center search switch remains disabled unless already explicitly enabled.
        Schema::table('students', function (Blueprint $table): void {
            $table->boolean('sharing_enabled')->default(true);
        });
        Schema::table('student_search_policy', function (Blueprint $table): void {
            $table->boolean('default_sharing_enabled')->default(true);
        });
    }

    public function down(): void
    {
        Schema::table('students', fn (Blueprint $table) => $table->dropColumn('sharing_enabled'));
        Schema::table('student_search_policy', fn (Blueprint $table) => $table->dropColumn('default_sharing_enabled'));
    }
};
