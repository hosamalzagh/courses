<?php

namespace App\Filament\Resources\Centers\Pages;

use App\Filament\Resources\Centers\CenterResource;
use App\Jobs\ProvisionCenter;
use App\Models\Center;
use App\Support\CenterDomain;
use App\Support\PlatformAudit;
use Filament\Resources\Pages\CreateRecord;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

class CreateCenter extends CreateRecord
{
    protected static string $resource = CenterResource::class;

    protected function handleRecordCreation(array $data): Model
    {
        $domain = CenterDomain::fromSubdomain($data['subdomain'], 'data.subdomain');
        CenterDomain::validateUnique($domain, field: 'data.subdomain');

        $center = DB::connection('central')->transaction(function () use ($data, $domain): Center {
            $center = Center::create([
                'name' => $data['name'], 'slug' => $data['slug'], 'plan' => $data['plan'],
                'owner_email' => strtolower($data['owner_email']),
            ]);
            $center->domains()->create(['domain' => $domain]);
            PlatformAudit::record(auth()->user(), $center, 'center.created', ['domain' => $domain]);

            return $center;
        });
        ProvisionCenter::dispatch($center->id);

        return $center;
    }
}
