<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('student_attachments', function (Blueprint $table): void {
            $table->unsignedInteger('current_version')->default(1);
            $table->string('content_classification', 16)->default('general');
            $table->timestamp('archived_at')->nullable();
            $table->unsignedBigInteger('archived_by')->nullable();
            $table->index(['student_id', 'archived_at', 'created_at']);
        });
        Schema::create('student_attachment_versions', function (Blueprint $table): void {
            $table->uuid('id')->primary();
            $table->foreignUuid('attachment_id')->constrained('student_attachments');
            $table->unsignedInteger('version');
            $table->string('classification', 16);
            $table->string('mime', 40);
            $table->unsignedBigInteger('size_bytes');
            $table->string('path');
            $table->unsignedBigInteger('actor_id');
            $table->string('actor_name')->nullable();
            $table->timestamp('created_at');
            $table->unique(['attachment_id', 'version']);
        });
        Schema::create('student_attachment_operations', function (Blueprint $table): void {
            $table->uuid('request_id')->primary();
            $table->foreignUuid('attachment_id')->constrained('student_attachments');
            $table->string('kind', 20);
            $table->string('request_hash', 64);
            $table->unsignedBigInteger('actor_id');
            $table->timestamp('created_at');
        });

        DB::table('student_attachments')->orderBy('id')->chunk(200, function ($rows): void {
            $names = DB::connection('central')->table('users')->whereIn('id', $rows->pluck('actor_id')->all())->pluck('name', 'id');
            foreach ($rows as $row) {
                DB::table('student_attachment_versions')->insert([
                    'id' => (string) Str::uuid(), 'attachment_id' => $row->id, 'version' => 1,
                    'classification' => $row->classification, 'mime' => $row->mime,
                    'size_bytes' => $row->size_bytes, 'path' => $row->path,
                    'actor_id' => $row->actor_id, 'actor_name' => $names[$row->actor_id] ?? null, 'created_at' => $row->created_at,
                ]);
                DB::table('student_attachments')->where('id', $row->id)->update(['content_classification' => $row->classification]);
            }
        });
    }

    public function down(): void
    {
        if (DB::table('student_attachment_versions')->exists()
            || DB::table('student_attachment_operations')->exists()
            || DB::table('student_attachments')->whereNotNull('archived_at')->exists()) {
            throw new RuntimeException('Cannot roll back attachment version history after versioning, classification or archiving has been used.');
        }

        Schema::dropIfExists('student_attachment_operations');
        Schema::dropIfExists('student_attachment_versions');
        Schema::table('student_attachments', function (Blueprint $table): void {
            $table->dropIndex(['student_id', 'archived_at', 'created_at']);
            $table->dropColumn(['current_version', 'content_classification', 'archived_at', 'archived_by']);
        });
    }
};
