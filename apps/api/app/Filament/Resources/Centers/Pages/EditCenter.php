<?php

namespace App\Filament\Resources\Centers\Pages;

use App\Filament\Resources\Centers\CenterResource;
use App\Support\CenterDomain;
use App\Support\PlatformAudit;
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
        CenterDomain::validateUnique($domain, $old, 'data.subdomain');
        unset($data['subdomain'], $data['slug'], $data['owner_email']);
        DB::connection('central')->transaction(function () use ($record, $data, $domain, $old): void {
            $before = [...$record->only(array_keys($data)), 'domain' => $old];
            $record->update($data);
            if ($domain !== $old) {
                $record->domains()->delete();
                $record->domains()->create(['domain' => $domain]);
            }
            $changes = PlatformAudit::changes($before, [...$record->only(array_keys($data)), 'domain' => $domain]);
            if ($changes !== []) {
                PlatformAudit::record(auth()->user(), $record, 'center.updated', [
                    'fields' => array_keys($changes), 'domain' => $domain, 'changes' => $changes,
                ]);
            }
        });

        return $record;
    }
}
