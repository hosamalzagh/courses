<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('branches', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('slug')->unique();
            $table->text('address')->nullable();
            $table->timestamps();
        });
        Schema::create('center_grants', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('user_id');
            $table->string('role');
            $table->timestamps();
            $table->unique(['user_id', 'role']);
        });
        Schema::create('branch_grants', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('user_id');
            $table->foreignId('branch_id')->constrained('branches');
            $table->string('role');
            $table->timestamps();
            $table->unique(['user_id', 'branch_id', 'role']);
        });
        Schema::create('center_audit_logs', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('actor_id')->nullable();
            $table->unsignedBigInteger('branch_id')->nullable();
            $table->string('event');
            $table->json('details')->nullable();
            $table->timestamp('created_at');
            $table->index(['branch_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('center_audit_logs');
        Schema::dropIfExists('branch_grants');
        Schema::dropIfExists('center_grants');
        Schema::dropIfExists('branches');
    }
};
