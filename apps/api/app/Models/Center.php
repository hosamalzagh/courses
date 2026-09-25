<?php

namespace App\Models;

use Stancl\Tenancy\Contracts\TenantWithDatabase;
use Stancl\Tenancy\Database\Concerns\HasDatabase;
use Stancl\Tenancy\Database\Concerns\HasDomains;
use Stancl\Tenancy\Database\Models\Tenant;

class Center extends Tenant implements TenantWithDatabase
{
    use HasDatabase, HasDomains;

    public static function getCustomColumns(): array
    {
        return ['id', 'name', 'slug', 'plan', 'owner_email', 'provisioning_status', 'suspended', 'provisioning_error', 'database_state', 'migration_version', 'provisioned_at', 'created_at', 'updated_at'];
    }

    protected function casts(): array
    {
        return ['suspended' => 'boolean', 'provisioned_at' => 'datetime'];
    }
}
