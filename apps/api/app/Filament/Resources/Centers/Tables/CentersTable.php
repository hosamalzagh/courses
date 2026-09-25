<?php

namespace App\Filament\Resources\Centers\Tables;

use Filament\Actions\EditAction;
use Filament\Actions\ViewAction;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;

class CentersTable
{
    public static function configure(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('name')->label('المركز')->searchable()->sortable(),
                TextColumn::make('slug')->label('الرمز')->searchable(),
                TextColumn::make('domains.domain')->label('النطاق')->searchable(),
                TextColumn::make('plan')->label('الخطة'),
                TextColumn::make('provisioning_status')->label('التجهيز')->badge(),
                TextColumn::make('suspended')->label('الإيقاف')->formatStateUsing(fn ($state) => $state ? 'موقوف' : 'نشط'),
            ])
            ->filters([
                //
            ])
            ->recordActions([
                ViewAction::make(),
                EditAction::make()->visible(fn () => auth()->user()?->platform_role === 'platform_owner'),
            ]);
    }
}
