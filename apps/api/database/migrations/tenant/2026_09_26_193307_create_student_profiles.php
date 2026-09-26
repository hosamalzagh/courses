<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('students', function (Blueprint $table) {
            $table->bigIncrements('student_number');
            $table->uuid('id')->unique();
            $table->string('name');
            $table->string('phone', 50)->nullable()->index();
            $table->string('name_search')->index();
            $table->string('phone_search', 50)->nullable()->index();
            $table->unsignedInteger('revision')->default(1);
            $table->uuid('request_id')->unique();
            $table->string('request_hash', 64);
            $table->unsignedBigInteger('created_by');
            $table->timestamps();
        });
        Schema::create('student_branches', function (Blueprint $table) {
            $table->foreignUuid('student_id')->constrained('students', 'id');
            $table->foreignId('branch_id')->constrained('branches');
            $table->timestamp('created_at');
            $table->primary(['student_id', 'branch_id']);
            $table->index(['branch_id', 'student_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('student_branches');
        Schema::dropIfExists('students');
    }
};
