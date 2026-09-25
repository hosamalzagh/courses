<?php

namespace App\Filament\Resources\Centers\Schemas;

use Filament\Infolists\Components\TextEntry;
use Filament\Schemas\Schema;

class CenterInfolist
{
    public static function configure(Schema $schema): Schema
    {
        return $schema
            ->components([
                TextEntry::make('name')->label('المركز'),
                TextEntry::make('slug')->label('الرمز'),
                TextEntry::make('plan')->label('الخطة'),
                TextEntry::make('provisioning_status')->label('حالة التجهيز')->badge(),
                TextEntry::make('database_state')->label('قاعدة البيانات'),
                TextEntry::make('migration_version')->label('آخر migration'),
                TextEntry::make('provisioning_error')->label('سبب فشل التجهيز'),
                TextEntry::make('domains.domain')->label('النطاقات'),
            ]);
    }
}
