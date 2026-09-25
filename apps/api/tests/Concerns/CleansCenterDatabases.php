<?php

namespace Tests\Concerns;

use App\Models\Center;
use Illuminate\Foundation\Testing\RefreshDatabaseState;
use Illuminate\Support\Facades\DB;

trait CleansCenterDatabases
{
    protected function tearDown(): void
    {
        if (app()->environment('testing') && config('database.connections.central.database') === 'courses_test_central') {
            tenancy()->end();
            DB::purge('tenant');

            foreach (Center::all() as $center) {
                $name = $center->database()->getName();

                if (preg_match('/^courses_center_[a-f0-9-]{36}$/', $name)) {
                    DB::connection('provisioning')->statement("DROP DATABASE IF EXISTS \"{$name}\" WITH (FORCE)");
                }
            }
        }

        RefreshDatabaseState::$migrated = false;
        parent::tearDown();
    }
}
