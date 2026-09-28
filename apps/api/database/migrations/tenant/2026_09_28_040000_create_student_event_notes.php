<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('student_event_notes', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('student_id')->constrained('students')->restrictOnDelete();
            $table->foreignId('branch_id')->constrained('branches')->restrictOnDelete();
            $table->string('event_type', 40);
            $table->uuid('event_id');
            $table->text('body');
            $table->boolean('important')->default(false);
            $table->unsignedInteger('revision')->default(1);
            $table->unsignedBigInteger('created_by');
            $table->string('created_by_name');
            $table->unsignedBigInteger('updated_by');
            $table->string('updated_by_name');
            $table->timestamps();
            $table->unique(['event_type', 'event_id']);
            $table->index(['student_id', 'branch_id', 'important', 'updated_at']);
        });
        Schema::create('student_event_note_revisions', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('note_id')->constrained('student_event_notes')->restrictOnDelete();
            $table->unsignedInteger('revision');
            $table->text('body');
            $table->boolean('important');
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_name');
            $table->uuid('request_id')->unique();
            $table->char('request_hash', 64);
            $table->timestamp('created_at');
            $table->unique(['note_id', 'revision']);
        });
        DB::statement("ALTER TABLE student_event_notes ADD CONSTRAINT student_event_note_body_valid CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000)");
        DB::statement("ALTER TABLE student_event_note_revisions ADD CONSTRAINT student_event_note_revision_body_valid CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000)");
        DB::statement(<<<'SQL'
CREATE FUNCTION preserve_student_event_note_revision() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Student event note revisions are immutable';
END;
$$ LANGUAGE plpgsql;
SQL);
        DB::statement('CREATE TRIGGER preserve_student_event_note_revision BEFORE UPDATE OR DELETE ON student_event_note_revisions FOR EACH ROW EXECUTE FUNCTION preserve_student_event_note_revision()');
    }

    public function down(): void
    {
        Schema::dropIfExists('student_event_note_revisions');
        DB::statement('DROP FUNCTION IF EXISTS preserve_student_event_note_revision()');
        Schema::dropIfExists('student_event_notes');
    }
};
