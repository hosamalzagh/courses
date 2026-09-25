<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->text('app_authentication_secret')->nullable();
            $table->text('app_authentication_recovery_codes')->nullable();
            $table->string('platform_role')->nullable()->index();
            $table->string('phone')->nullable();
        });

        Schema::create('center_memberships', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained();
            $table->string('tenant_id');
            $table->string('status')->default('invited');
            $table->unsignedBigInteger('grants_version')->default(1);
            $table->timestamps();
            $table->unique(['user_id', 'tenant_id']);
            $table->foreign('tenant_id')->references('id')->on('tenants');
        });

        Schema::create('center_invitations', function (Blueprint $table) {
            $table->id();
            $table->string('tenant_id');
            $table->string('email');
            $table->string('token_hash')->unique();
            $table->text('token_ciphertext');
            $table->string('center_role')->nullable();
            $table->timestamp('expires_at');
            $table->timestamp('accepted_at')->nullable();
            $table->timestamps();
            $table->unique(['tenant_id', 'email']);
            $table->foreign('tenant_id')->references('id')->on('tenants');
        });

        Schema::create('platform_audit_logs', function (Blueprint $table) {
            $table->id();
            $table->foreignId('actor_id')->nullable()->constrained('users');
            $table->string('tenant_id')->nullable();
            $table->string('event');
            $table->json('details')->nullable();
            $table->timestamp('created_at');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('platform_audit_logs');
        Schema::dropIfExists('center_invitations');
        Schema::dropIfExists('center_memberships');
        Schema::table('users', fn (Blueprint $table) => $table->dropColumn([
            'app_authentication_secret', 'app_authentication_recovery_codes', 'platform_role', 'phone',
        ]));
    }
};
