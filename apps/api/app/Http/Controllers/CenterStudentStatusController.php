<?php

namespace App\Http\Controllers;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Support\CenterPermissions;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class CenterStudentStatusController extends Controller
{
    public function store(Request $request, string $studentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId), 404);
        $request->merge(['reason' => is_string($request->input('reason')) ? trim($request->input('reason')) : $request->input('reason')]);
        $data = $request->validate([
            'status' => ['required', Rule::in(['active', 'suspended'])],
            'reason' => ['required', 'string', 'max:2000'],
            'status_revision' => ['required', 'integer', 'min:1'],
            'request_id' => ['required', 'uuid'],
        ], ['reason.required' => 'أدخل سبب تغيير حالة الطالب.']);

        return DB::connection('central')->transaction(function () use ($request, $studentId, $data): JsonResponse {
            $centerId = $request->attributes->get('center')->id;
            $center = Center::query()->whereKey($centerId)->lockForUpdate()->firstOrFail();
            abort_if($center->suspended, 423);
            abort_unless($center->provisioning_status === 'active', 503);
            abort_unless(CenterMembership::query()->where('tenant_id', $centerId)->where('user_id', $request->user()->id)->value('status') === 'active', 403);

            return DB::connection('tenant')->transaction(function () use ($request, $studentId, $data): JsonResponse {
                abort_unless(CenterPermissions::forUser($request->user()->id)->isCenterManager(), 403);
                $db = DB::connection('tenant');
                $student = $db->table('students')->where('id', $studentId)->lockForUpdate()->first();
                abort_unless($student, 404);
                $hash = hash('sha256', json_encode([$studentId, $data['status'], $data['reason'], (int) $data['status_revision']]));
                $existing = $db->table('student_suspensions')->where('suspended_request_id', $data['request_id'])->orWhere('lifted_request_id', $data['request_id'])->first();
                if ($existing) {
                    $kind = $existing->suspended_request_id === $data['request_id'] ? 'suspended' : 'lifted';
                    abort_unless($existing->{$kind.'_by'} === $request->user()->id, 403);
                    $this->requireCurrent($existing->{$kind.'_request_hash'} === $hash && $student->status === $data['status'] && $student->status_revision === (int) $data['status_revision'] + 1);

                    return response()->json(['status' => $student->status, 'status_revision' => $student->status_revision]);
                }
                $this->requireCurrent($student->status_revision === (int) $data['status_revision'] && $student->status !== $data['status']);
                $at = now()->format('Y-m-d H:i:s.uP');
                $values = ['request_id' => $data['request_id'], 'request_hash' => $hash, 'by' => $request->user()->id,
                    'by_name' => $request->user()->name, 'reason' => $data['reason'], 'at' => $at];
                $kind = $data['status'] === 'suspended' ? 'suspended' : 'lifted';
                $values = collect($values)->mapWithKeys(fn ($value, $key): array => [$kind.'_'.$key => $value])->all();
                if ($kind === 'suspended') {
                    $db->table('student_suspensions')->insert(['id' => (string) Str::uuid(), 'student_id' => $studentId, ...$values]);
                } else {
                    $period = $db->table('student_suspensions')->where('student_id', $studentId)->whereNull('lifted_at')->first();
                    $this->requireCurrent($period !== null);
                    $db->table('student_suspensions')->where('id', $period->id)->update($values);
                }
                $db->table('students')->where('id', $studentId)->update(['status' => $data['status'], 'status_revision' => $student->status_revision + 1, 'updated_at' => $at]);
                $branches = $db->table('student_branches')->where('student_id', $studentId)->pluck('branch_id');
                foreach ($branches as $branchId) {
                    $db->table('center_audit_logs')->insert(['actor_id' => $request->user()->id, 'branch_id' => $branchId,
                        'event' => $kind === 'suspended' ? 'student.suspended' : 'student.reactivated',
                        'details' => json_encode(['student_id' => $studentId, 'before' => $student->status, 'after' => $data['status'], 'reason' => $data['reason']]), 'created_at' => $at]);
                }

                return response()->json(['status' => $data['status'], 'status_revision' => $student->status_revision + 1]);
            });
        })->header('Cache-Control', 'private, no-store');
    }

    private function requireCurrent(bool $valid): void
    {
        if (! $valid) {
            throw new HttpResponseException(response()->json(['code' => 'student_status_changed'], 409));
        }
    }
}
