<?php

namespace App\Filament\Resources\Centers\Pages;

use App\Filament\Resources\Centers\CenterResource;
use App\Support\CenterDomain;
use Filament\Actions\ViewAction;
use Filament\Resources\Pages\EditRecord;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

class EditCenter extends EditRecord
{
    protected static string $resource = CenterResource::class;

    protected function getHeaderActions(): array
    {
        return [
            ViewAction::make(),
        ];
    }

    protected function mutateFormDataBeforeFill(array $data): array
    {
        $domain = $this->getRecord()->domains()->first()?->domain;
        $data['subdomain'] = $domain ? explode('.', $domain)[0] : '';

        return $data;
    }

    protected function handleRecordUpdate(Model $record, array $data): Model
    {
        $domain = CenterDomain::fromSubdomain($data['subdomain'], 'data.subdomain');
        $old = $record->domains()->first()?->domain;
        CenterDomain::validateUnique($domain, $old);
        unset($data['subdomain'], $data['slug'], $data['owner_email']);
        DB::connection('central')->transaction(function () use ($record, $data, $domain, $old): void {
            $record->update($data);
            if ($domain !== $old) {
                $record->domains()->delete();
                $record->domains()->create(['domain' => $domain]);
            }
            DB::connection('central')->table('platform_audit_logs')->insert([
                'actor_id' => auth()->id(), 'tenant_id' => $record->id, 'event' => 'center.updated',
                'details' => json_encode(['fields' => array_keys($data), 'domain' => $domain]),
                'created_at' => now(),
            ]);
        });

        return $record;
    }
}
