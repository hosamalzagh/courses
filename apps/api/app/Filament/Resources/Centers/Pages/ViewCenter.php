<?php

namespace App\Filament\Resources\Centers\Pages;

use App\Filament\Resources\Centers\CenterResource;
use App\Jobs\ProvisionCenter;
use Filament\Actions\Action;
use Filament\Actions\EditAction;
use Filament\Resources\Pages\ViewRecord;

class ViewCenter extends ViewRecord
{
    protected static string $resource = CenterResource::class;

    protected function getHeaderActions(): array
    {
        return [
            EditAction::make()->visible(fn () => auth()->user()?->platform_role === 'platform_owner'),
            Action::make('retry')->label('إعادة التجهيز')->visible(fn () => auth()->user()?->platform_role === 'platform_owner' && $this->getRecord()->provisioning_status === 'failed')
                ->requiresConfirmation()->action(fn () => ProvisionCenter::dispatch($this->getRecord()->id)),
        ];
    }
}
