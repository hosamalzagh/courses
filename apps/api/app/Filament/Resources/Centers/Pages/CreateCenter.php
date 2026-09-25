<?php

namespace App\Filament\Resources\Centers\Pages;

use App\Filament\Resources\Centers\CenterResource;
use App\Jobs\ProvisionCenter;
use App\Models\Center;
use App\Support\CenterDomain;
use Filament\Resources\Pages\CreateRecord;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

class CreateCenter extends CreateRecord
{
    protected static string $resource = CenterResource::class;

    protected function handleRecordCreation(array $data): Model
    {
        $domain = CenterDomain::fromSubdomain($data['subdomain'], 'data.subdomain');
        CenterDomain::validateUnique($domain);

        $center = DB::connection('central')->transaction(function () use ($data, $domain): Center {
            $center = Center::create([
                'name' => $data['name'], 'slug' => $data['slug'], 'plan' => $data['plan'],
                'owner_email' => strtolower($data['owner_email']),
            ]);
            $center->domains()->create(['domain' => $domain]);
            DB::connection('central')->table('platform_audit_logs')->insert([
                'actor_id' => auth()->id(), 'tenant_id' => $center->id,
                'event' => 'center.created', 'details' => json_encode(['domain' => $domain]),
                'created_at' => now(),
            ]);

            return $center;
        });
        ProvisionCenter::dispatch($center->id);

        return $center;
    }
}
