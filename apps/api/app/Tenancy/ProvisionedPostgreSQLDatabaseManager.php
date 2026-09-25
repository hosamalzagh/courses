<?php

namespace App\Tenancy;

use Illuminate\Support\Facades\DB;
use InvalidArgumentException;
use Stancl\Tenancy\Contracts\TenantWithDatabase;
use Stancl\Tenancy\TenantDatabaseManagers\PostgreSQLDatabaseManager;

class ProvisionedPostgreSQLDatabaseManager extends PostgreSQLDatabaseManager
{
    public function createDatabase(TenantWithDatabase $tenant): bool
    {
        $name = $tenant->database()->getName();

        if (! preg_match('/^courses_center_[a-f0-9-]{36}$/', $name)) {
            throw new InvalidArgumentException('Invalid center database name.');
        }

        $owner = config('database.connections.central.username');
        if (! preg_match('/^[a-z_][a-z0-9_]*$/', $owner)) {
            throw new InvalidArgumentException('Invalid PostgreSQL application role.');
        }

        return DB::connection('provisioning')->statement("CREATE DATABASE \"{$name}\" WITH OWNER = \"{$owner}\" TEMPLATE = template0");
    }

    public function databaseExists(string $name): bool
    {
        return (bool) DB::connection('central')->selectOne('SELECT 1 FROM pg_database WHERE datname = ?', [$name]);
    }

    public function deleteDatabase(TenantWithDatabase $tenant): bool
    {
        throw new InvalidArgumentException('Center databases must be removed by an explicit operator action.');
    }
}
