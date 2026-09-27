<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\StudentCustomFields;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

class CenterStudentCustomFieldController extends Controller
{
    public function workspace(Request $request): JsonResponse
    {
        $permissions = $request->attributes->get('center_permissions');
        abort_unless($permissions->isCenterManager() || collect($permissions->branchRoles)->contains(fn ($roles) => in_array('read', CenterPermissions::actions($roles), true)), 403);
        $data = $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000'], 'manage' => ['sometimes', 'boolean'], 'student_id' => ['sometimes', 'uuid']]);
        abort_if($request->boolean('manage') && ! $permissions->isCenterManager(), 403);
        $page = (int) ($data['page'] ?? 1);
        $query = DB::connection('tenant')->query()
            ->selectSub(DB::connection('tenant')->query()->fromSub(StudentCustomFields::pageQuery($page, $permissions, $data['student_id'] ?? null), 'fields')->selectRaw('json_agg(fields ORDER BY position, id)'), 'fields')
            ->selectSub(DB::connection('tenant')->table('center_settings')->where('id', 1)->select('student_custom_fields_revision'), 'revision');
        if (isset($data['student_id'])) {
            $scope = DB::connection('tenant')->table('student_branches')->where('student_id', $data['student_id']);
            if (! $permissions->isCenterManager()) {
                $scope->whereIn('branch_id', array_keys(array_filter($permissions->branchRoles, fn ($roles) => in_array('read', CenterPermissions::actions($roles), true))));
            }
            $query->selectSub($scope->selectRaw('count(*)'), 'student_scope')
                ->selectSub(DB::connection('tenant')->table('student_custom_field_values')->where('student_id', $data['student_id'])->whereIn('field_id', StudentCustomFields::pageQuery($page, $permissions, $data['student_id'] ?? null)->limit(50)->select('id'))->selectRaw('json_object_agg(field_id, value)'), 'values');
        }
        $workspace = $query->first();
        abort_if(isset($data['student_id']) && ! $workspace->student_scope, 404);
        $rows = collect(json_decode($workspace->fields ?? '[]'));

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']), 'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']), 'permissions' => $permissions->toArray(), 'branches' => [],
            'fields' => $rows->take(50)->map(fn ($row) => $this->payload($row))->values(), 'values' => (object) (json_decode($workspace->values ?? '{}', true) ?? []),
            'revision' => (int) $workspace->revision,
            'pagination' => ['page' => $page, 'has_more' => $rows->count() > 50],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function show(Request $request, string $fieldId): JsonResponse
    {
        abort_unless($request->attributes->get('center_permissions')->isCenterManager(), 403);
        abort_unless(Str::isUuid($fieldId), 404);
        $field = StudentCustomFields::definitionsQuery()->where('id', $fieldId)->first();
        abort_unless($field, 404);

        return response()->json(['field' => $this->payload($field)])->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate(['classification' => ['sometimes', Rule::in(['general', 'identity'])], 'id' => ['required', 'uuid'], 'type' => ['required', Rule::in(StudentCustomFields::TYPES)], 'options' => ['present', 'array', 'max:100'], 'options.*' => ['required', 'string', 'max:100', 'distinct'], ...$this->rules()]);
        $data['label'] = trim($data['label']);
        $data['options'] = array_map('trim', $data['options']);
        $request->merge($data);
        $request->validate(['label' => ['required'], 'options.*' => ['required', 'distinct'], 'options' => $data['type'] === 'select' ? ['min:1'] : ['size:0']]);

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $data): JsonResponse {
            abort_unless($permissions->isCenterManager(), 403);
            $hash = hash('sha256', json_encode($data));
            $existing = DB::connection('tenant')->table('student_custom_fields')->where('id', $data['id'])->first();
            if ($existing) {
                abort_unless($existing->created_by === $request->user()->id, 403);
                if ($existing->request_hash !== $hash) {
                    StudentCustomFields::conflict();
                }

                return response()->json(['field' => $this->payload(StudentCustomFields::definitionsQuery()->where('id', $existing->id)->first())]);
            }
            DB::connection('tenant')->table('student_custom_fields')->insert([...$data, 'options' => json_encode($data['options']), 'request_hash' => $hash, 'created_by' => $request->user()->id, 'created_at' => now(), 'updated_at' => now()]);
            $after = $this->payload(StudentCustomFields::definitionsQuery()->where('id', $data['id'])->first());
            $this->record($request, null, $after);

            return response()->json(['field' => $after], 201);
        });
    }

    public function update(Request $request, string $fieldId): JsonResponse
    {
        abort_unless(Str::isUuid($fieldId), 404);
        $data = $request->validate([...$this->rules(), 'revision' => ['required', 'integer', 'min:1'], 'type' => ['sometimes', Rule::in(StudentCustomFields::TYPES)], 'options' => ['sometimes', 'array', 'max:100'], 'options.*' => ['required', 'string', 'max:100', 'distinct'], 'classification' => ['sometimes', Rule::in(['general', 'identity'])], 'active' => ['sometimes', 'boolean'], 'disabled_options' => ['sometimes', 'array', 'max:100'], 'disabled_options.*' => ['required', 'string', 'distinct']]);
        $data['label'] = trim($data['label']);
        abort_if($data['label'] === '', 422, 'أدخل اسم الحقل.');

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $data, $fieldId): JsonResponse {
            abort_unless($permissions->isCenterManager(), 403);
            $row = DB::connection('tenant')->table('student_custom_fields')->where('id', $fieldId)->lockForUpdate()->first();
            abort_unless($row, 404);
            $before = $this->payload($row);
            $type = $data['type'] ?? $row->type;
            $options = isset($data['options']) ? array_map('trim', $data['options']) : $before['options'];
            if ($type !== $row->type && DB::connection('tenant')->table('student_custom_field_history')->where('field_id', $fieldId)->exists()) {
                throw ValidationException::withMessages(['type' => 'استُعمل هذا الحقل سابقًا. أنشئ حقلًا جديدًا لتغيير النوع؛ يبقى التاريخ محفوظًا.']);
            }
            $request->merge(['options' => $options]);
            $request->validate(['options' => $type === 'select' ? ['min:1'] : ['size:0'], 'options.*' => ['required', 'distinct']]);
            if ($type === $row->type && array_diff($before['options'], $options) !== []) {
                throw ValidationException::withMessages(['options' => 'عطّل الاختيار بدل حذفه حتى يبقى تاريخه محفوظًا.']);
            }
            $disabled = $data['disabled_options'] ?? $before['disabled_options'];
            $request->merge(['disabled_options' => $disabled]);
            $request->validate(['disabled_options.*' => [Rule::in($options)]]);
            $changes = ['classification' => $data['classification'] ?? $row->classification, 'type' => $type, 'options' => $options, 'label' => $data['label'], 'position' => (int) $data['position'], 'required' => (bool) $data['required'], 'active' => (bool) ($data['active'] ?? $row->active), 'disabled_options' => $disabled];
            if (array_intersect_key($before, $changes) == $changes) {
                return response()->json(['field' => $before]);
            }
            if ((int) $row->revision !== (int) $data['revision']) {
                StudentCustomFields::conflict();
            }
            DB::connection('tenant')->table('student_custom_fields')->where('id', $fieldId)->update([...$changes, 'options' => json_encode($options), 'disabled_options' => json_encode($disabled), 'revision' => $row->revision + 1, 'updated_at' => now()]);
            $after = $this->payload(StudentCustomFields::definitionsQuery()->where('id', $fieldId)->first());
            $this->record($request, $before, $after);

            return response()->json(['field' => $after]);
        });
    }

    private function rules(): array
    {
        return ['label' => ['required', 'string', 'max:255'], 'required' => ['required', 'boolean'], 'position' => ['required', 'integer', 'min:0', 'max:1000000']];
    }

    private function payload(object $row): array
    {
        return [...array_intersect_key((array) $row, array_flip(['id', 'label', 'type', 'required', 'position', 'revision', 'active', 'used', 'classification'])), 'disabled_options' => is_string($row->disabled_options) ? json_decode($row->disabled_options, true) : $row->disabled_options, 'options' => is_string($row->options) ? json_decode($row->options, true) : $row->options];
    }

    private function record(Request $request, ?array $before, array $after): void
    {
        DB::connection('tenant')->table('center_settings')->where('id', 1)->increment('student_custom_fields_revision');
        DB::connection('tenant')->table('center_audit_logs')->insert(['actor_id' => $request->user()->id, 'event' => 'center.student_custom_field_changed', 'details' => json_encode(['before' => $before, 'after' => $after]), 'created_at' => now()]);
    }
}
