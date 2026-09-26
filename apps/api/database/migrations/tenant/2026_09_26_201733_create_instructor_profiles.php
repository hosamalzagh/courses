<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('instructors', function (Blueprint $table) {
            $table->uuid('id')->primary();
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
        Schema::create('instructor_branches', function (Blueprint $table) {
            $table->foreignUuid('instructor_id')->constrained('instructors', 'id');
            $table->foreignId('branch_id')->constrained('branches');
            $table->timestamp('created_at');
            $table->primary(['instructor_id', 'branch_id']);
            $table->index(['branch_id', 'instructor_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('instructor_branches');
        Schema::dropIfExists('instructors');
    }
};
