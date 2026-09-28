<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('content_equivalences', fn (Blueprint $table) => $table->index('target_plan_version_id', 'content_equivalences_target_plan_idx'));
    }

    public function down(): void
    {
        Schema::table('content_equivalences', fn (Blueprint $table) => $table->dropIndex('content_equivalences_target_plan_idx'));
    }
};
