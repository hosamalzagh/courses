<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('student_profile_choices', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->string('kind', 32);
            $table->string('label');
            $table->unsignedInteger('position')->default(0);
            $table->boolean('active')->default(true);
            $table->unsignedInteger('revision')->default(1);
            $table->string('request_hash', 64);
            $table->unsignedBigInteger('created_by');
            $table->timestamps();
            $table->index(['kind', 'active', 'position', 'id']);
        });
        Schema::table('students', function (Blueprint $table): void {
            foreach (['city', 'qualification', 'profession', 'collection_method', 'discovery_source'] as $kind) {
                $table->foreignUuid($kind.'_id')->nullable()->constrained('student_profile_choices')->restrictOnDelete();
            }
        });
    }

    public function down(): void
    {
        Schema::table('students', function (Blueprint $table): void {
            foreach (['city', 'qualification', 'profession', 'collection_method', 'discovery_source'] as $kind) {
                $table->dropConstrainedForeignId($kind.'_id');
            }
        });
        Schema::dropIfExists('student_profile_choices');
    }
};
