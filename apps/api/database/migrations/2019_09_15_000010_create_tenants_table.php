<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

class CreateTenantsTable extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('tenants', function (Blueprint $table) {
            $table->string('id')->primary();
            $table->string('name');
            $table->string('slug')->unique();
            $table->string('plan');
            $table->string('owner_email');
            $table->string('provisioning_status')->default('pending');
            $table->boolean('suspended')->default(false);
            $table->text('provisioning_error')->nullable();
            $table->string('database_state')->default('not_created');
            $table->string('migration_version')->nullable();
            $table->timestamp('provisioned_at')->nullable();
            $table->timestamps();
            $table->json('data')->nullable();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('tenants');
    }
}
