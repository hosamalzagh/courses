<?php

namespace App\Filament\Resources\Users\Pages;

use App\Filament\Resources\Users\UserResource;
use App\Models\User;
use App\Support\PlatformAudit;
use Filament\Resources\Pages\EditRecord;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class EditUser extends EditRecord
{
    protected static string $resource = UserResource::class;

    protected function getHeaderActions(): array
    {
        return [];
    }

    protected function handleRecordUpdate(Model $record, array $data): Model
    {
        if ($record->platform_role === 'platform_owner' && $data['platform_role'] !== 'platform_owner'
            && User::query()->where('platform_role', 'platform_owner')->count() <= 1) {
            throw ValidationException::withMessages(['data.platform_role' => 'لا يمكن إزالة آخر مالك للمنصة.']);
        }
        $oldRole = $record->platform_role;
        $oldValues = $record->only(['name', 'email', 'password']);
        DB::connection('central')->transaction(function () use ($record, $data, $oldRole, $oldValues): void {
            $record->fill($data);
            $record->platform_role = $data['platform_role'];
            $record->save();
            $changedFields = [];
            foreach ($oldValues as $field => $oldValue) {
                if ($record->{$field} !== $oldValue) {
                    $changedFields[] = $field;
                }
            }
            if ($changedFields !== []) {
                PlatformAudit::record(auth()->user(), null, 'platform_user.updated', [
                    'user_id' => $record->id, 'user_name' => $record->name, 'changed_fields' => $changedFields,
                    'changes' => PlatformAudit::changes($oldValues, $record->only(['name', 'email'])),
                ]);
            }
            if ($oldRole !== $record->platform_role) {
                PlatformAudit::record(auth()->user(), null, 'platform_user.role_changed', [
                    'user_id' => $record->id, 'user_name' => $record->name,
                    'old_role' => $oldRole, 'new_role' => $record->platform_role,
                    'changes' => PlatformAudit::changes(['platform_role' => $oldRole], ['platform_role' => $record->platform_role]),
                ]);
            }
        });

        return $record;
    }
}
