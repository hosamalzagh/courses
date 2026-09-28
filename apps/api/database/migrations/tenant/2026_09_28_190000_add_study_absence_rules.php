<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        foreach (['courses', 'stages', 'levels', 'study_groups'] as $name) {
            Schema::table($name, function (Blueprint $table) use ($name): void {
                $table->string('absence_mode', 20)->nullable()->default($name === 'courses' ? 'consecutive' : null);
                $table->unsignedSmallInteger('absence_limit')->nullable();
                $table->unsignedInteger('absence_revision')->default(1);
            });
            DB::statement("ALTER TABLE {$name} ADD CONSTRAINT {$name}_absence_rule_valid CHECK (((absence_mode IS NULL OR absence_mode = 'disabled') AND absence_limit IS NULL) OR (absence_mode IN ('consecutive', 'total') AND (absence_limit IS NULL OR absence_limit BETWEEN 1 AND 999)))");
        }
    }

    public function down(): void
    {
        foreach (['study_groups', 'levels', 'stages', 'courses'] as $name) {
            DB::statement("ALTER TABLE {$name} DROP CONSTRAINT IF EXISTS {$name}_absence_rule_valid");
            Schema::table($name, fn (Blueprint $table) => $table->dropColumn(['absence_mode', 'absence_limit', 'absence_revision']));
        }
    }
};
