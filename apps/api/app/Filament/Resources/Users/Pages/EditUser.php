<?php

namespace App\Filament\Resources\Users\Pages;

use App\Filament\Resources\Users\UserResource;
use App\Models\User;
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
                DB::connection('central')->table('platform_audit_logs')->insert([
                    'actor_id' => auth()->id(), 'event' => 'platform_user.updated',
                    'details' => json_encode(['user_id' => $record->id, 'changed_fields' => $changedFields]),
                    'created_at' => now(),
                ]);
            }
            if ($oldRole !== $record->platform_role) {
                DB::connection('central')->table('platform_audit_logs')->insert([
                    'actor_id' => auth()->id(), 'event' => 'platform_user.role_changed',
                    'details' => json_encode(['user_id' => $record->id, 'old_role' => $oldRole, 'new_role' => $record->platform_role]),
                    'created_at' => now(),
                ]);
            }
        });

        return $record;
    }
}
