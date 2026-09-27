<?php

namespace App\Filament\Resources\Users\Pages;

use App\Filament\Resources\Users\UserResource;
use App\Models\User;
use App\Support\PlatformAudit;
use Filament\Resources\Pages\CreateRecord;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

class CreateUser extends CreateRecord
{
    protected static string $resource = UserResource::class;

    protected function handleRecordCreation(array $data): Model
    {
        return DB::connection('central')->transaction(function () use ($data): User {
            $user = User::create($data);
            $user->platform_role = $data['platform_role'];
            $user->email_verified_at = now();
            $user->save();
            PlatformAudit::record(auth()->user(), null, 'platform_user.created', [
                'user_id' => $user->id, 'user_name' => $user->name, 'role' => $user->platform_role,
            ]);

            return $user;
        });
    }
}
