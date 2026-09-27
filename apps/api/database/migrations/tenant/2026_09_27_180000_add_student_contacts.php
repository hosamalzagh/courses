<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // The existing phone remains an unassigned legacy number. Never infer its owner.
        Schema::table('students', function (Blueprint $table) {
            $table->jsonb('contacts')->default('[]');
            $table->jsonb('channels')->default('{}');
            $table->jsonb('contact_phones')->default('[]');
        });
    }

    public function down(): void
    {
        Schema::table('students', fn (Blueprint $table) => $table->dropColumn(['contacts', 'channels', 'contact_phones']));
    }
};
