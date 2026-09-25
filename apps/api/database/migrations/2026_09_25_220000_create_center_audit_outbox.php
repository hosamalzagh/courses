<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::connection('central')->create('center_audit_outbox', function (Blueprint $table) {
            $table->id();
            $table->string('tenant_id')->index();
            $table->unsignedBigInteger('actor_id')->nullable();
            $table->string('event');
            $table->json('details')->nullable();
            $table->timestamp('created_at');
            $table->timestamp('delivered_at')->nullable()->index();
        });
    }

    public function down(): void
    {
        Schema::connection('central')->dropIfExists('center_audit_outbox');
    }
};
