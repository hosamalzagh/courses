<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('students', function (Blueprint $table): void {
            $table->uuid('photo_id')->nullable();
            $table->unsignedInteger('photo_revision')->default(1);
        });
        Schema::create('student_photos', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('student_id')->constrained('students');
            $table->string('request_hash', 64);
            $table->unsignedInteger('photo_revision');
            $table->string('path');
            $table->string('mime', 40);
            $table->text('preview');
            $table->unsignedBigInteger('actor_id');
            $table->timestamp('created_at');
            $table->index(['student_id', 'photo_revision']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('student_photos');
        Schema::table('students', function (Blueprint $table): void {
            $table->dropColumn(['photo_id', 'photo_revision']);
        });
    }
};
