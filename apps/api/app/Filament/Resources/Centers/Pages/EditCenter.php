<?php

namespace App\Filament\Resources\Centers\Pages;

use App\Filament\Resources\Centers\CenterResource;
use Filament\Actions\ViewAction;
use Filament\Resources\Pages\EditRecord;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

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
        $subdomain = $data['subdomain'];
        if (! preg_match('/^[a-z][a-z0-9-]{1,62}$/', $subdomain)
            || in_array($subdomain, ['platform', 'www', 'api'], true)) {
            throw ValidationException::withMessages(['data.subdomain' => 'النطاق الفرعي غير صالح.']);
        }
        $domain = $subdomain.'.'.config('courses.base_domain');
        $old = $record->domains()->first()?->domain;
        if ($domain !== $old) {
            validator(['domain' => $domain], ['domain' => 'unique:domains,domain'])->validate();
        }
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
