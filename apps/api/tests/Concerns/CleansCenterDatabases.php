<?php

namespace Tests\Concerns;

use App\Models\Center;
use Illuminate\Foundation\Testing\RefreshDatabaseState;
use Illuminate\Support\Facades\DB;

trait CleansCenterDatabases
{
    protected function tearDown(): void
    {
        $centralDatabase = config('database.connections.central.database');
        if (app()->environment('testing') && (in_array($centralDatabase, ['courses_test_central', 'courses_test_central_issue70'], true)
            || preg_match('/^courses_issue[0-9]+_test_central$/', $centralDatabase) === 1)) {
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
