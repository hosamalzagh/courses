<?php

namespace App\Tenancy;

use Stancl\Tenancy\Bootstrappers\DatabaseTenancyBootstrapper;
use Stancl\Tenancy\Contracts\Tenant;

class CenterDatabaseBootstrapper extends DatabaseTenancyBootstrapper
{
    public function bootstrap(Tenant $tenant): void
    {
        $this->database->connectToTenant($tenant);
    }
}
