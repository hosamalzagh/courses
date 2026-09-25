<?php

namespace App\Filament\Resources\Users\Schemas;

use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Schemas\Schema;

class UserForm
{
    public static function configure(Schema $schema): Schema
    {
        return $schema
            ->components([
                TextInput::make('name')->label('الاسم')->required(),
                TextInput::make('email')->label('البريد الإلكتروني')->email()->required()->unique(ignoreRecord: true),
                Select::make('platform_role')->label('الدور')->options([
                    'platform_owner' => 'مالك المنصة', 'platform_support' => 'دعم المنصة',
                ])->required(),
                TextInput::make('password')->label('كلمة مرور مؤقتة')->password()
                    ->required(fn (string $operation) => $operation === 'create')
                    ->dehydrated(fn (?string $state) => filled($state))
                    ->minLength(12),
            ]);
    }
}
