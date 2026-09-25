<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class CenterSettingsController extends Controller
{
    public function show(Request $request): JsonResponse
    {
        $settings = DB::connection('tenant')->table('center_settings')->where('id', 1)
            ->first(['contact_email', 'phone', 'address']);

        return response()->json(['settings' => $settings ?: [
            'contact_email' => null, 'phone' => null, 'address' => null,
        ]])->header('Cache-Control', 'private, no-store');
    }

    public function update(Request $request): JsonResponse
    {
        abort_unless($request->attributes->get('center_permissions')->isCenterManager(), 403);
        $data = $request->validate([
            'contact_email' => ['nullable', 'email', 'max:255'],
            'phone' => ['nullable', 'string', 'max:50'],
            'address' => ['nullable', 'string', 'max:2000'],
        ]);
        DB::connection('tenant')->table('center_settings')->updateOrInsert(
            ['id' => 1], [...$data, 'updated_at' => now(), 'created_at' => now()],
        );
        DB::connection('tenant')->table('center_audit_logs')->insert([
            'actor_id' => $request->user()->id, 'event' => 'center.settings_updated',
            'details' => json_encode(array_keys($data)), 'created_at' => now(),
        ]);

        return $this->show($request);
    }
}
