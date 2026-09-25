<?php

namespace App\Filament\Resources\Centers;

use App\Filament\Resources\Centers\Pages\CreateCenter;
use App\Filament\Resources\Centers\Pages\EditCenter;
use App\Filament\Resources\Centers\Pages\ListCenters;
use App\Filament\Resources\Centers\Pages\ViewCenter;
use App\Filament\Resources\Centers\Schemas\CenterForm;
use App\Filament\Resources\Centers\Schemas\CenterInfolist;
use App\Filament\Resources\Centers\Tables\CentersTable;
use App\Models\Center;
use BackedEnum;
use Filament\Resources\Resource;
use Filament\Schemas\Schema;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Model;

class CenterResource extends Resource
{
    protected static ?string $model = Center::class;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedBuildingOffice2;

    protected static ?string $navigationLabel = 'المراكز';

    protected static ?string $modelLabel = 'مركز';

    protected static ?string $pluralModelLabel = 'المراكز';

    public static function canViewAny(): bool
    {
        return in_array(auth()->user()?->platform_role, ['platform_owner', 'platform_support'], true);
    }

    public static function canCreate(): bool
    {
        return auth()->user()?->platform_role === 'platform_owner';
    }

    public static function canEdit(Model $record): bool
    {
        return static::canCreate();
    }

    public static function canDelete(Model $record): bool
    {
        return false;
    }

    public static function form(Schema $schema): Schema
    {
        return CenterForm::configure($schema);
    }

    public static function infolist(Schema $schema): Schema
    {
        return CenterInfolist::configure($schema);
    }

    public static function table(Table $table): Table
    {
        return CentersTable::configure($table);
    }

    public static function getRelations(): array
    {
        return [
            //
        ];
    }

    public static function getPages(): array
    {
        return [
            'index' => ListCenters::route('/'),
            'create' => CreateCenter::route('/create'),
            'view' => ViewCenter::route('/{record}'),
            'edit' => EditCenter::route('/{record}/edit'),
        ];
    }
}
