<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('student_custom_fields', function (Blueprint $table): void {
            $table->string('classification', 20)->default('general');
            $table->boolean('active')->default(true);
            $table->jsonb('disabled_options')->default('[]');
        });
        Schema::create('student_custom_field_history', function (Blueprint $table): void {
            $table->bigIncrements('id');
            $table->uuid('student_id');
            $table->uuid('field_id');
            $table->unsignedInteger('profile_revision');
            $table->string('label', 255);
            $table->string('type', 20);
            $table->jsonb('value')->nullable();
            $table->unsignedBigInteger('actor_id')->nullable();
            $table->string('actor_name')->nullable();
            $table->boolean('imported')->default(false);
            $table->timestamp('created_at');
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('field_id')->references('id')->on('student_custom_fields');
            $table->unique(['student_id', 'field_id', 'profile_revision']);
            $table->index(['student_id', 'id']);
            $table->index('field_id');
        });
        DB::statement('INSERT INTO student_custom_field_history (student_id, field_id, profile_revision, label, type, value, imported, created_at) SELECT values.student_id, values.field_id, students.revision, fields.label, fields.type, values.value, true, values.updated_at FROM student_custom_field_values AS values JOIN students ON students.id = values.student_id JOIN student_custom_fields AS fields ON fields.id = values.field_id');
    }

    public function down(): void
    {
        Schema::dropIfExists('student_custom_field_history');
        Schema::table('student_custom_fields', fn (Blueprint $table) => $table->dropColumn(['classification', 'active', 'disabled_options']));
    }
};
