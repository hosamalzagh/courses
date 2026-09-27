<?php

namespace App\Filament\Resources\PlatformAuditLogs\Pages;

use App\Filament\Resources\PlatformAuditLogs\PlatformAuditLogResource;
use Filament\Resources\Pages\ManageRecords;

class ManagePlatformAuditLogs extends ManageRecords
{
    protected static string $resource = PlatformAuditLogResource::class;

    public function boot(): void
    {
        abort_unless(PlatformAuditLogResource::canViewAny(), 403);
        app()->setLocale('ar');
    }

    public function getSubheading(): ?string
    {
        return 'من نفّذ التغيير، وفي أي مركز، وما الذي تغيّر. جميع الأوقات بتوقيت القاهرة.';
    }

    protected function getHeaderActions(): array
    {
        return [];
    }
}
