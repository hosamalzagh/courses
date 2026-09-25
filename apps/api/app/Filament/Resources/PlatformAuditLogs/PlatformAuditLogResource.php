<?php

namespace App\Filament\Resources\PlatformAuditLogs;

use App\Filament\Resources\PlatformAuditLogs\Pages\ManagePlatformAuditLogs;
use App\Models\PlatformAuditLog;
use BackedEnum;
use Filament\Resources\Resource;
use Filament\Schemas\Schema;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Model;

class PlatformAuditLogResource extends Resource
{
    protected static ?string $model = PlatformAuditLog::class;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedClipboardDocumentList;

    protected static ?string $navigationLabel = 'سجل المنصة';

    protected static ?string $modelLabel = 'حدث منصة';

    protected static ?string $pluralModelLabel = 'سجل المنصة';

    public static function canViewAny(): bool
    {
        return auth()->user()?->platform_role === 'platform_owner';
    }

    public static function canCreate(): bool
    {
        return false;
    }

    public static function canEdit(Model $record): bool
    {
        return false;
    }

    public static function canDelete(Model $record): bool
    {
        return false;
    }

    public static function form(Schema $schema): Schema
    {
        return $schema
            ->components([
                TextColumn::make('created_at')->label('الوقت')->dateTime()->sortable(),
                TextColumn::make('event')->label('الحدث')->searchable(),
                TextColumn::make('actor_id')->label('رقم المنفذ'),
                TextColumn::make('tenant_id')->label('معرّف المركز'),
                TextColumn::make('details')->label('التفاصيل')->limit(80),
            ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                //
            ])
            ->filters([
                //
            ])
            ->defaultSort('created_at', 'desc');
    }

    public static function getPages(): array
    {
        return [
            'index' => ManagePlatformAuditLogs::route('/'),
        ];
    }
}
