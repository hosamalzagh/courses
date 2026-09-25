<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class CenterInvitation extends Model
{
    protected $connection = 'central';

    protected $fillable = ['tenant_id', 'email', 'token_hash', 'token_ciphertext', 'center_role', 'expires_at', 'accepted_at', 'delivery_claimed_at', 'sent_at'];

    protected function casts(): array
    {
        return ['expires_at' => 'datetime', 'accepted_at' => 'datetime', 'delivery_claimed_at' => 'datetime', 'sent_at' => 'datetime', 'token_ciphertext' => 'encrypted'];
    }
}
