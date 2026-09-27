<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('student_custom_fields', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->string('label', 255);
            $table->string('type', 20);
            $table->boolean('required')->default(false);
            $table->unsignedInteger('position')->default(0);
            $table->jsonb('options')->default('[]');
            $table->unsignedInteger('revision')->default(1);
            $table->unsignedBigInteger('created_by');
            $table->string('request_hash', 64);
            $table->timestamps();
            $table->index(['position', 'id']);
            $table->index('required');
        });
        Schema::create('student_custom_field_values', function (Blueprint $table): void {
            $table->uuid('student_id');
            $table->uuid('field_id');
            $table->jsonb('value');
            $table->timestamps();
            $table->primary(['student_id', 'field_id']);
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('field_id')->references('id')->on('student_custom_fields');
        });
        Schema::table('center_settings', fn (Blueprint $table) => $table->unsignedInteger('student_custom_fields_revision')->default(1));
        // Historical centers can predate the provisioning of this singleton.
        DB::table('center_settings')->insertOrIgnore(['id' => 1, 'contact_email' => tenant('owner_email'), 'created_at' => now(), 'updated_at' => now()]);
    }

    public function down(): void
    {
        Schema::dropIfExists('student_custom_field_values');
        Schema::dropIfExists('student_custom_fields');
        Schema::table('center_settings', fn (Blueprint $table) => $table->dropColumn('student_custom_fields_revision'));
    }
};
