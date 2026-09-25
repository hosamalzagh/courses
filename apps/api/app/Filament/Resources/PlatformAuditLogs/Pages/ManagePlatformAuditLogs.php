<?php

namespace App\Filament\Resources\PlatformAuditLogs\Pages;

use App\Filament\Resources\PlatformAuditLogs\PlatformAuditLogResource;
use Filament\Resources\Pages\ManageRecords;

class ManagePlatformAuditLogs extends ManageRecords
{
    protected static string $resource = PlatformAuditLogResource::class;

    protected function getHeaderActions(): array
    {
        return [];
    }
}
