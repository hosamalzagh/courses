<?php

namespace App\Http\Controllers;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Support\CenterPermissions;
use App\Support\StudentProfileChoices;
use Closure;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

class CenterStudentProfileChoiceController extends Controller
{
    public function workspace(Request $request): JsonResponse
    {
        $permissions = $request->attributes->get('center_permissions');
        $manager = $permissions->isCenterManager();
        abort_unless($manager || collect($permissions->branchRoles)->contains(fn ($roles) => in_array('students.manage', CenterPermissions::actions($roles), true)), 403);
        $data = $request->validate(['kind' => ['required', Rule::in(StudentProfileChoices::KINDS)], 'page' => ['sometimes', 'integer', 'min:1', 'max:100000'], 'q' => ['nullable', 'string', 'max:255'], 'manage' => ['sometimes', 'boolean']]);
        abort_if($request->boolean('manage') && ! $manager, 403);
        $page = (int) ($data['page'] ?? 1);
        $choices = DB::connection('tenant')->table('student_profile_choices')->where('kind', $data['kind'])
            ->when(! $request->boolean('manage'), fn ($query) => $query->where('active', true))
            ->when(trim($data['q'] ?? '') !== '', fn ($query) => $query->whereRaw('strpos(lower(label), lower(?)) > 0', [trim($data['q'])]))
            ->orderBy('position')->orderBy('id')->offset(($page - 1) * 50)->limit(51)->get(['id', 'kind', 'label', 'active', 'position', 'revision']);

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(), 'branches' => [],
            'choices' => $choices->take(50)->values(), 'pagination' => ['page' => $page, 'has_more' => $choices->count() > 50],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function show(Request $request, string $choiceId): JsonResponse
    {
        abort_unless($request->attributes->get('center_permissions')->isCenterManager(), 403);
        abort_unless(Str::isUuid($choiceId), 404);
        $choice = DB::connection('tenant')->table('student_profile_choices')->where('id', $choiceId)->first();
        abort_unless($choice, 404);

        return response()->json(['choice' => $this->payload($choice)])->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate(['id' => ['required', 'uuid'], 'kind' => ['required', Rule::in(StudentProfileChoices::KINDS)], ...$this->rules()]);
        $data['label'] = trim($data['label']);
        abort_if($data['label'] === '', 422, 'أدخل اسم الاختيار.');

        return $this->write($request, function () use ($request, $data): JsonResponse {
            $hash = hash('sha256', json_encode($data));
            $existing = DB::connection('tenant')->table('student_profile_choices')->where('id', $data['id'])->first();
            if ($existing) {
                abort_unless($existing->created_by === $request->user()->id, 403);
                if ($existing->request_hash !== $hash) {
                    $this->conflict();
                }

                return response()->json(['choice' => $this->payload($existing)]);
            }
            DB::connection('tenant')->table('student_profile_choices')->insert([...$data, 'request_hash' => $hash, 'created_by' => $request->user()->id, 'created_at' => now(), 'updated_at' => now()]);
            $choice = $this->payload(DB::connection('tenant')->table('student_profile_choices')->where('id', $data['id'])->first());
            $this->audit($request, null, $choice);

            return response()->json(['choice' => $choice], 201);
        });
    }

    public function update(Request $request, string $choiceId): JsonResponse
    {
        abort_unless(Str::isUuid($choiceId), 404);
        $data = $request->validate([...$this->rules(), 'revision' => ['required', 'integer', 'min:1'], 'kind' => ['prohibited']]);
        $data['label'] = trim($data['label']);
        abort_if($data['label'] === '', 422, 'أدخل اسم الاختيار.');

        return $this->write($request, function () use ($request, $data, $choiceId): JsonResponse {
            $row = DB::connection('tenant')->table('student_profile_choices')->where('id', $choiceId)->lockForUpdate()->first();
            abort_unless($row, 404);
            $before = $this->payload($row);
            if ($row->label === $data['label'] && (int) $row->position === (int) $data['position'] && (bool) $row->active === (bool) $data['active']) {
                return response()->json(['choice' => $before]);
            }
            if ((int) $row->revision !== (int) $data['revision']) {
                $this->conflict();
            }
            DB::connection('tenant')->table('student_profile_choices')->where('id', $choiceId)->update([...$data, 'revision' => $row->revision + 1, 'updated_at' => now()]);
            $after = $this->payload(DB::connection('tenant')->table('student_profile_choices')->where('id', $choiceId)->first());
            $this->audit($request, $before, $after);

            return response()->json(['choice' => $after]);
        });
    }

    private function rules(): array
    {
        return ['label' => ['required', 'string', 'max:255'], 'position' => ['required', 'integer', 'min:0', 'max:1000000'], 'active' => ['required', 'boolean']];
    }

    private function payload(object $choice): array
    {
        return array_intersect_key((array) $choice, array_flip(['id', 'kind', 'label', 'position', 'active', 'revision']));
    }

    private function write(Request $request, Closure $operation): JsonResponse
    {
        // The central lock also serializes student selection and definition writes.
        return DB::connection('central')->transaction(function () use ($request, $operation): JsonResponse {
            $centerId = $request->attributes->get('center')->id;
            $center = Center::query()->whereKey($centerId)->lockForUpdate()->firstOrFail();
            abort_if($center->suspended, 423);
            abort_unless($center->provisioning_status === 'active', 503);
            abort_unless(CenterMembership::query()->where('tenant_id', $centerId)->where('user_id', $request->user()->id)->value('status') === 'active', 403);

            return DB::connection('tenant')->transaction(function () use ($request, $operation): JsonResponse {
                abort_unless(CenterPermissions::forUser($request->user()->id)->isCenterManager(), 403);

                return $operation();
            });
        });
    }

    private function audit(Request $request, ?array $before, array $after): void
    {
        DB::connection('tenant')->table('center_audit_logs')->insert(['actor_id' => $request->user()->id,
            'event' => 'center.student_profile_choice_changed', 'details' => json_encode(['before' => $before, 'after' => $after]), 'created_at' => now()]);
    }

    private function conflict(): never
    {
        throw new HttpResponseException(response()->json(['code' => 'student_profile_choice_changed', 'message' => 'تغير الاختيار أو الطلب. حمّل القائمة الحالية لمراجعتها.'], 409));
    }
}
