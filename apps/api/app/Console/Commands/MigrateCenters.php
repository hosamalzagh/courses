<?php

namespace App\Console\Commands;

use App\Models\Center;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Throwable;

#[Signature('courses:migrate-centers {--center= : Migrate one center by slug; omit to migrate all centers}')]
#[Description('Migrate each selected center independently and report its result')]
class MigrateCenters extends Command
{
    public function handle(): int
    {
        $slug = $this->option('center');
        $centers = Center::query()
            ->when($slug !== null, fn ($query) => $query->where('slug', $slug))
            ->orderBy('slug')
            ->get();

        if ($centers->isEmpty()) {
            $this->error('No centers matched.');

            return self::FAILURE;
        }

        $failed = false;
        foreach ($centers as $center) {
            try {
                if (! $center->database()->manager()->databaseExists($center->database()->getName())) {
                    $center->update([
                        'database_state' => 'not_created',
                        'migration_version' => null,
                        'provisioning_status' => 'failed',
                        'provisioning_error' => 'قاعدة بيانات المركز غير موجودة. استخدم إعادة التجهيز.',
                    ]);
                    $this->error($center->slug.': failed (database missing)');
                    $failed = true;

                    continue;
                }

                $center->update(['database_state' => 'available']);
                if ($this->call('tenants:migrate', ['--tenants' => [$center->id], '--force' => true]) !== 0) {
                    throw new RuntimeException('Center migrations failed.');
                }

                $center->refreshMigrationVersion();
                $this->info($center->slug.': migrated ('.$center->migration_version.')');
            } catch (Throwable $exception) {
                if ($center->database_state === 'available') {
                    try {
                        $center->refreshMigrationVersion();
                    } catch (Throwable $diagnosticException) {
                        report($diagnosticException);
                    }
                }

                $center->update([
                    'provisioning_status' => 'failed',
                    'provisioning_error' => 'تعذر ترحيل قاعدة بيانات المركز. راجع سجل التشغيل وأعد المحاولة.',
                ]);
                $this->error($center->slug.': failed (migration error)');
                report($exception);
                $failed = true;
            } finally {
                tenancy()->end();
                DB::purge('tenant');
            }
        }

        return $failed ? self::FAILURE : self::SUCCESS;
    }
}
