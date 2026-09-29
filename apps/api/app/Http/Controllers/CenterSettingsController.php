<?php

namespace App\Http\Controllers;

use App\Support\CenterWrites;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class CenterSettingsController extends Controller
{
    public function show(Request $request): JsonResponse
    {
        abort_unless($request->attributes->get('center_permissions')->isCenterManager(), 403);
        $settings = DB::connection('tenant')->table('center_settings')->where('id', 1)
            ->first(['contact_email', 'phone', 'address', 'student_number_start', 'student_number_revision', 'student_code_enabled', 'student_code_label', 'student_code_revision', 'student_all_branches_enabled', 'student_all_branches_revision', 'financial_currency', 'financial_currency_revision', 'financial_currency_locked_at']);

        return response()->json(['settings' => $settings ?: [
            'contact_email' => null, 'phone' => null, 'address' => null, 'student_number_start' => 1, 'student_number_revision' => 1,
            'student_all_branches_enabled' => false, 'student_all_branches_revision' => 1,
            'financial_currency' => null, 'financial_currency_revision' => 1, 'financial_currency_locked_at' => null,
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
        DB::connection('tenant')->transaction(function () use ($request, $data): void {
            DB::connection('tenant')->table('center_settings')->updateOrInsert(
                ['id' => 1], [...$data, 'updated_at' => now(), 'created_at' => now()],
            );
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'event' => 'center.settings_updated',
                'details' => json_encode(array_keys($data)), 'created_at' => now(),
            ]);
        });

        return $this->show($request);
    }

    public function updateStudentBranches(Request $request): JsonResponse
    {
        abort_unless($request->attributes->get('center_permissions')->isCenterManager(), 403);
        $data = $request->validate([
            'enabled' => ['required', 'boolean'],
            'revision' => ['required', 'integer', 'min:1'],
        ]);

        return CenterWrites::run($request, function ($permissions) use ($request, $data): JsonResponse {
            abort_unless($permissions->isCenterManager(), 403);
            $settings = DB::connection('tenant')->table('center_settings')->where('id', 1)->lockForUpdate()->first();
            $enabled = (bool) $data['enabled'];
            if ((bool) $settings->student_all_branches_enabled !== $enabled) {
                if ((int) $settings->student_all_branches_revision !== (int) $data['revision']) {
                    return response()->json(['code' => 'student_all_branches_settings_changed', 'message' => 'تغير إعداد ربط الطلاب بالفروع. حمّل الإعداد الحالي.'], 409);
                }
                DB::connection('tenant')->table('center_settings')->where('id', 1)->update([
                    'student_all_branches_enabled' => $enabled,
                    'student_all_branches_revision' => (int) $settings->student_all_branches_revision + 1,
                    'updated_at' => now(),
                ]);
                DB::connection('tenant')->table('center_audit_logs')->insert([
                    'actor_id' => $request->user()->id,
                    'event' => 'center.student_all_branches_settings_changed',
                    'details' => json_encode(['before' => (bool) $settings->student_all_branches_enabled, 'after' => $enabled]),
                    'created_at' => now(),
                ]);
            }

            return $this->show($request);
        });
    }
}
