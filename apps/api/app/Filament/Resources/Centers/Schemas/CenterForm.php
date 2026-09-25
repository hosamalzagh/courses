<?php

namespace App\Filament\Resources\Centers\Schemas;

use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Schemas\Schema;

class CenterForm
{
    public static function configure(Schema $schema): Schema
    {
        return $schema
            ->components([
                TextInput::make('name')->label('اسم المركز')->required()->maxLength(255),
                TextInput::make('slug')->label('الرمز')->required()->alphaDash()->unique(ignoreRecord: true)->disabledOn('edit'),
                TextInput::make('subdomain')->label('النطاق الفرعي')->required()->alphaDash(),
                Select::make('plan')->label('الخطة')->options(['starter' => 'بداية', 'growth' => 'نمو'])->required(),
                TextInput::make('owner_email')->label('بريد المالك الأول')->email()->required()->disabledOn('edit'),
                Toggle::make('suspended')->label('المركز موقوف')->visibleOn('edit'),
            ]);
    }
}
