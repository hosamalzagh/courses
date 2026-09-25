<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('center_invitations', function (Blueprint $table) {
            $table->timestamp('delivery_claimed_at')->nullable();
            $table->timestamp('sent_at')->nullable();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('center_invitations', function (Blueprint $table) {
            $table->dropColumn(['delivery_claimed_at', 'sent_at']);
        });
    }
};
