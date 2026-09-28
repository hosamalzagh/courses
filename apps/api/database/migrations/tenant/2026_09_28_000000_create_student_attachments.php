<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('students', function (Blueprint $table): void {
            $table->unsignedInteger('attachment_revision')->default(1);
        });
        Schema::create('student_attachments', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('student_id')->constrained('students');
            $table->uuid('request_id');
            $table->unsignedSmallInteger('position');
            $table->string('request_hash', 64);
            $table->string('title', 120);
            $table->string('classification', 16);
            $table->string('mime', 40);
            $table->unsignedBigInteger('size_bytes');
            $table->string('path');
            $table->unsignedBigInteger('actor_id');
            $table->timestamp('created_at');
            $table->unique(['request_id', 'position']);
            $table->index(['student_id', 'created_at', 'id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('student_attachments');
        Schema::table('students', function (Blueprint $table): void {
            $table->dropColumn('attachment_revision');
        });
    }
};
