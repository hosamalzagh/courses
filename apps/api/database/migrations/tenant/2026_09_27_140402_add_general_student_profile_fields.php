<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('students', function (Blueprint $table) {
            $table->date('date_of_birth')->nullable();
            $table->string('gender', 10)->nullable();
            $table->string('address', 1000)->nullable();
            $table->string('email')->nullable();
            $table->string('school')->nullable();
            $table->string('employer')->nullable();
            $table->string('specialization')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('students', function (Blueprint $table) {
            $table->dropColumn(['date_of_birth', 'gender', 'address', 'email', 'school', 'employer', 'specialization']);
        });
    }
};
