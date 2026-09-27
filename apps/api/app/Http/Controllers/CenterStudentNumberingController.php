<?php

namespace App\Http\Controllers;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Support\CenterPermissions;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class CenterStudentNumberingController extends Controller
{
    public function update(Request $request): JsonResponse
    {
        $data = $request->validate([
            'start' => ['required', 'integer', 'min:1', 'max:9007199254740990'],
            'revision' => ['required', 'integer', 'min:1'],
        ], ['start.min' => 'أدخل رقم بداية أكبر من صفر.', 'start.integer' => 'أدخل رقم بداية صحيحًا.']);

        return DB::connection('central')->transaction(function () use ($request, $data): JsonResponse {
            $centerId = $request->attributes->get('center')->id;
            $center = Center::query()->whereKey($centerId)->lockForUpdate()->firstOrFail();
            abort_if($center->suspended, 423);
            abort_unless($center->provisioning_status === 'active', 503);
            abort_unless(CenterMembership::query()->where('tenant_id', $centerId)->where('user_id', $request->user()->id)->value('status') === 'active', 403);

            return DB::connection('tenant')->transaction(function () use ($request, $data): JsonResponse {
                abort_unless(CenterPermissions::forUser($request->user()->id)->isCenterManager(), 403);
                DB::connection('tenant')->table('center_settings')->insertOrIgnore(['id' => 1, 'created_at' => now(), 'updated_at' => now()]);
                $settings = DB::connection('tenant')->table('center_settings')->where('id', 1)->lockForUpdate()->first();
                if ((int) $settings->student_number_revision !== (int) $data['revision']) {
                    throw new HttpResponseException(response()->json(['code' => 'student_numbering_changed', 'message' => 'تغير إعداد الترقيم. حمّل الإعداد الحالي ثم أعد المحاولة.'], 409));
                }
                if ((int) $settings->student_number_start !== (int) $data['start']) {
                    DB::connection('tenant')->table('center_settings')->where('id', 1)->update([
                        'student_number_start' => $data['start'], 'student_number_revision' => $settings->student_number_revision + 1, 'updated_at' => now(),
                    ]);
                    DB::connection('tenant')->table('center_audit_logs')->insert([
                        'actor_id' => $request->user()->id, 'event' => 'center.student_numbering_changed',
                        'details' => json_encode(['before' => (int) $settings->student_number_start, 'after' => (int) $data['start']]), 'created_at' => now(),
                    ]);
                }

                return (new CenterSettingsController)->show($request);
            });
        });
    }
}
