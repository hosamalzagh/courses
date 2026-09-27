<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\StudentBarcode;
use App\Support\StudentContacts;
use App\Support\StudentCustomFields;
use App\Support\StudentIdentity;
use App\Support\StudentManualCodes;
use App\Support\StudentProfileChoices;
use Carbon\CarbonImmutable;
use Closure;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use stdClass;

class CenterStudentController extends Controller
{
    private const GENERAL_FIELDS = ['date_of_birth', 'gender', 'address', 'email', 'school', 'employer', 'specialization', 'city_id', 'qualification_id', 'profession_id', 'collection_method_id', 'discovery_source_id'];

    public function workspace(Request $request, ?string $studentId = null): JsonResponse
    {
        $data = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'status_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'branches_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'q' => ['nullable', 'string', 'max:255'],
            'identifier' => ['nullable', 'string', 'max:50'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        $page = (int) ($data['page'] ?? 1);
        $branchPage = (int) ($data['branches_page'] ?? 1);
        $branches = DB::connection('tenant')->table('branches')->orderBy('id');
        if (! $permissions->isCenterManager()) {
            $branches->whereIn('id', $this->branchScope($permissions, 'read'));
        }
        $branchRows = $branches->offset(($branchPage - 1) * 50)->limit(51)->select(['id', 'name', 'slug', 'address']);
        $workspace = DB::connection('tenant')->query()
            ->selectSub(DB::connection('tenant')->query()->fromSub($branchRows, 'branch_rows')->selectRaw('json_agg(branch_rows)'), 'branches')
            ->selectSub(StudentProfileChoices::initialQuery(), 'choices')
            ->selectSub(StudentCustomFields::initialQuery(), 'custom_fields')
            ->selectSub(DB::connection('tenant')->table('center_settings')->where('id', 1)->select('student_custom_fields_revision'), 'custom_fields_revision')
            ->selectSub(DB::connection('tenant')->table('center_settings')->where('id', 1)->selectRaw("json_build_object('enabled', student_code_enabled, 'label', student_code_label, 'revision', student_code_revision)"), 'code_settings')->first();
        $branches = collect(json_decode($workspace->branches ?? '[]'));
        $choiceRows = collect(json_decode($workspace->choices ?? '[]', true));
        $choices = [];
        foreach (StudentProfileChoices::KINDS as $kind) {
            $rows = $choiceRows->where('kind', $kind)->values();
            $choices[$kind] = ['choices' => $rows->take(50)->values(), 'page' => 1, 'has_more' => $rows->count() > 50];
        }
        $query = $this->visibleStudents($permissions, false, $studentId !== null);
        if ($studentId !== null) {
            abort_unless(Str::isUuid($studentId), 404);
            $query->where('students.id', $studentId);
        }
        if (isset($data['q']) && trim($data['q']) !== '') {
            $search = $this->normalizeName($data['q']);
            $phone = $this->normalizePhone($data['q']);
            $query->where(function (Builder $rows) use ($search, $phone, $data): void {
                $rows->whereRaw('strpos(name_search, ?) > 0', [$search]);
                if ($phone !== null) {
                    StudentContacts::matchPhone($rows, $phone);
                }
                if (ctype_digit($data['q']) && strlen($data['q']) <= 18) {
                    $rows->orWhere('student_number', $data['q']);
                }
            });
        }
        if (isset($data['identifier']) && trim($data['identifier']) !== '') {
            $query->whereIn('students.id', StudentManualCodes::identifiers(trim($data['identifier'])));
        }

        if ($studentId !== null) {
            $statusPage = (int) ($data['status_page'] ?? 1);
            $history = DB::connection('tenant')->table('student_suspensions')->where('student_id', $studentId)
                ->orderByDesc('suspended_at')->orderByDesc('id')->offset(($statusPage - 1) * 20)->limit(21)
                ->select(['id', 'suspended_by', 'suspended_by_name', 'suspended_reason', 'suspended_at', 'lifted_by', 'lifted_by_name', 'lifted_reason', 'lifted_at']);
            $query->selectSub(DB::connection('tenant')->query()->fromSub($history, 'periods')->selectRaw('json_agg(periods)'), 'suspensions');
        }
        $students = $query->orderBy('student_number')->offset(($page - 1) * 50)->limit(51)->get();
        if ($studentId !== null) {
            abort_if($students->isEmpty(), 404);
        }

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(),
            'branches' => $branches->take(50)->values(),
            'profile_choice_lists' => $choices,
            'student_code_settings' => json_decode($workspace->code_settings, true),
            'custom_fields' => ['fields' => array_slice(json_decode($workspace->custom_fields ?? '[]', true) ?? [], 0, 50), 'revision' => (int) $workspace->custom_fields_revision, 'page' => 1, 'has_more' => count(json_decode($workspace->custom_fields ?? '[]', true) ?? []) > 50],
            'students' => $students->take(50)->map(fn (stdClass $student): array => $this->payload($student, $permissions))->values(),
            ...($studentId !== null ? ['suspensions' => array_slice(json_decode($students->first()->suspensions ?? '[]', true) ?? [], 0, 20), 'status_pagination' => ['page' => $statusPage, 'has_more' => count(json_decode($students->first()->suspensions ?? '[]', true) ?? []) > 20]] : []),
            'pagination' => ['page' => $page, 'has_more' => $students->count() > 50, 'branches_page' => $branchPage, 'branches_has_more' => $branches->count() > 50],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function similar(Request $request): JsonResponse
    {
        $data = $request->validate(['name' => ['nullable', 'string', 'max:255'], 'phone' => ['nullable', 'string', 'max:50'], 'exclude' => ['nullable', 'uuid'], 'phones' => ['sometimes', 'array', 'max:25'], 'phones.*' => ['string', 'max:50']]);
        $permissions = $request->attributes->get('center_permissions');
        $query = $this->visibleStudents($permissions, true);
        $name = $this->normalizeName($data['name'] ?? '');
        $phones = StudentContacts::normalizePhones([...($data['phones'] ?? []), $data['phone'] ?? null]);
        if ($name === '' && $phones === []) {
            return response()->json(['students' => []])->header('Cache-Control', 'private, no-store');
        }
        $query->where(function (Builder $query) use ($name, $phones): void {
            if ($name !== '') {
                $query->where('name_search', $name);
            }
            foreach ($phones as $phone) {
                StudentContacts::matchPhone($query, $phone, true);
            }
        })->when(! empty($data['exclude']), fn (Builder $query) => $query->where('students.id', '!=', $data['exclude']));

        return response()->json(['students' => $query->orderBy('student_number')->limit(10)->get()
            ->map(fn (stdClass $student): array => $student->branch_ids === null
                ? ['id' => $student->id, 'student_number' => $student->student_number, 'name' => $student->name, 'phone' => $student->phone, 'within_scope' => false]
                : [...$this->payload($student, $permissions), 'within_scope' => true])])
            ->header('Cache-Control', 'private, no-store');
    }

    public function submission(Request $request, string $requestId): JsonResponse
    {
        abort_unless(Str::isUuid($requestId), 404);
        $permissions = $request->attributes->get('center_permissions');
        $student = $this->visibleStudents($permissions, false, true)->where('request_id', $requestId)
            ->where('created_by', $request->user()->id)->first();
        abort_unless($student, 404);

        return response()->json(['student' => $this->payload($student, $permissions)])
            ->header('Cache-Control', 'private, no-store');
    }

    public function barcode(Request $request, string $studentId): Response
    {
        abort_unless(Str::isUuid($studentId), 404);
        $student = $this->visibleStudents($request->attributes->get('center_permissions'))->where('students.id', $studentId)->first();
        abort_unless($student, 404);
        $number = (int) $student->student_number;
        $svg = StudentBarcode::svg($number);

        return response('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>طباعة الباركود الأساسي</title><style>body{margin:24px;text-align:center;font-family:system-ui;color:#000;background:#fff}svg{display:block;margin:24px auto 8px;max-width:100%;height:auto}p{font-size:20px;font-family:monospace}button{padding:12px 24px;font:inherit}@media print{button{display:none}body{margin:0}}</style><body>'.$svg.'<p dir="ltr">'.$number.'</p><button onclick="window.print()">طباعة الباركود</button></body></html>')
            ->header('Cache-Control', 'private, no-store')
            ->header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'")
            ->header('X-Content-Type-Options', 'nosniff');
    }

    public function store(Request $request): JsonResponse
    {
        $data = $this->validateProfile($request);
        $request->validate(['request_id' => ['required', 'uuid']]);

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $data): JsonResponse {
            $this->authorizeBranches($permissions, $data['branch_ids']);
            StudentIdentity::authorize($data, $permissions, $data['branch_ids']);
            $hash = hash('sha256', json_encode($data));
            $existing = DB::connection('tenant')->table('students')->where('request_id', $request->input('request_id'))->first();
            if ($existing) {
                abort_unless($existing->created_by === $request->user()->id, 403);
                if ($existing->request_hash !== $hash) {
                    $this->conflict('student_request_changed');
                }

                return response()->json(['student' => $this->read($existing->id, $permissions)]);
            }
            StudentManualCodes::validate($data['manual_code'] ?? null);
            $identity = StudentIdentity::columns($data, $permissions, $data['branch_ids']);
            StudentProfileChoices::validate($data);
            $customValues = StudentCustomFields::validate($data);
            $start = DB::connection('tenant')->table('center_settings')->where('id', 1)->value('student_number_start');
            $sequence = DB::connection('tenant')->selectOne('SELECT last_value, is_called FROM students_student_number_seq');
            $next = (int) $sequence->last_value + ($sequence->is_called ? 1 : 0);
            if (max($next, (int) $start) > 9007199254740991) {
                throw new HttpResponseException(response()->json(['code' => 'student_numbering_exhausted', 'message' => 'وصل ترقيم الطلاب إلى الحد المدعوم. تواصل مع مسؤول المركز.'], 409));
            }
            StudentManualCodes::validateAllocation(max($next, (int) $start));
            if ((int) $start > $next) {
                DB::connection('tenant')->selectOne("SELECT setval('students_student_number_seq', ?, false)", [(int) $start]);
            }
            $id = (string) Str::uuid();
            DB::connection('tenant')->table('students')->insert([
                ...array_intersect_key($data, array_flip(self::GENERAL_FIELDS)),
                ...$identity,
                ...StudentContacts::columns($data),
                'id' => $id, 'name' => $data['name'], 'phone' => $data['phone'], 'manual_code' => $data['manual_code'] ?? null, 'manual_code_number' => StudentManualCodes::number($data['manual_code'] ?? null),
                'sharing_enabled' => (bool) DB::connection('tenant')->table('student_search_policy')->where('id', 1)->value('default_sharing_enabled'),
                'name_search' => $this->normalizeName($data['name']), 'phone_search' => $this->normalizePhone($data['phone']),
                'request_id' => $request->input('request_id'), 'request_hash' => $hash, 'created_by' => $request->user()->id,
                'created_at' => now(), 'updated_at' => now(),
            ]);
            StudentCustomFields::save($id, $customValues);
            $this->associate($id, $data['branch_ids']);
            $student = $this->read($id, $permissions);
            $this->audit($request, 'student.created', $student, null, $data['branch_ids'], [], array_keys(array_filter($customValues, fn ($value) => $value !== null)));

            return response()->json(['student' => $student], 201);
        });
    }

    public function update(Request $request, string $studentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId), 404);
        $data = $this->validateProfile($request);
        $request->validate(['revision' => ['required', 'integer', 'min:1']]);

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $data, $studentId): JsonResponse {
            $row = DB::connection('tenant')->table('students')->where('id', $studentId)->lockForUpdate()->first();
            abort_unless($row, 404);
            $before = $this->read($studentId, $permissions);
            abort_unless($before['can_manage'], 403);
            $this->authorizeBranches($permissions, $data['branch_ids']);
            // Omitted legacy phone preserves it. Old callers echoing the summary cannot assign an owner.
            if (! $request->exists('phone') || (! isset($data['contacts']) && $before['contacts'] !== [] && $data['phone'] === $before['phone'])) {
                $data['phone'] = $row->phone;
            } elseif (! isset($data['contacts']) && $before['contacts'] !== [] && $data['phone'] !== $row->phone) {
                throw ValidationException::withMessages(['contacts' => 'عدّل الرقم من جهات التواصل وقنواته.']);
            }
            $currentBranches = DB::connection('tenant')->table('student_branches')->where('student_id', $studentId)->pluck('branch_id')->all();
            StudentIdentity::authorize($data, $permissions, $currentBranches);
            $identity = array_intersect_key($data, array_flip(StudentIdentity::FIELDS));
            $identityChanged = collect($identity)->contains(fn ($value, $field): bool => $row->{$field} !== $value);
            $added = array_diff($data['branch_ids'], $currentBranches);
            $general = array_intersect_key($data, array_flip(self::GENERAL_FIELDS));
            $contactChanged = isset($data['contacts']) && ($before['contacts'] != $data['contacts'] || $before['channels'] != $data['channels']);
            $manualCode = $data['manual_code'] ?? (array_key_exists('manual_code', $data) ? null : $row->manual_code);
            $manualChanged = $row->manual_code !== $manualCode;
            $storedCustom = DB::connection('tenant')->table('student_custom_field_values')->where('student_id', $studentId)->pluck('value', 'field_id')->map(fn ($value) => json_decode($value, true))->all();
            $customChanged = collect($data['custom_values'] ?? [])->contains(fn ($value, $field) => ($storedCustom[$field] ?? null) !== $value);
            $generalChanged = collect($general)->contains(fn ($value, $field): bool => $row->{$field} !== $value);
            if (($identityChanged || $manualChanged || $contactChanged || $generalChanged || $customChanged || $row->name !== $data['name'] || $row->phone !== $data['phone'] || $added !== []) && $row->revision !== (int) $request->input('revision')) {
                $this->conflict('student_changed');
            }
            $customValues = StudentCustomFields::validate($data, $studentId);
            if (! $customChanged && ! $identityChanged && ! $manualChanged && ! $contactChanged && ! $generalChanged && $row->name === $data['name'] && $row->phone === $data['phone'] && $added === []) {
                return response()->json(['student' => $before]);
            }
            $identity = StudentIdentity::columns($data, $permissions, $currentBranches, $row);
            if ($manualChanged) {
                StudentManualCodes::validate($manualCode, $studentId);
            }
            StudentProfileChoices::validate($data, $row);
            DB::connection('tenant')->table('students')->where('id', $studentId)->update([
                ...$general,
                ...$identity,
                ...StudentContacts::columns($data),
                'name' => $data['name'], 'phone' => $data['phone'], 'manual_code' => $manualCode, 'manual_code_number' => StudentManualCodes::number($manualCode),
                'name_search' => $this->normalizeName($data['name']), 'phone_search' => $this->normalizePhone($data['phone']),
                'revision' => $row->revision + 1, 'updated_at' => now(),
            ]);
            $changedCustomValues = array_filter($customValues, fn ($value, $id) => ($storedCustom[$id] ?? null) !== $value, ARRAY_FILTER_USE_BOTH);
            StudentCustomFields::save($studentId, $changedCustomValues);
            $this->associate($studentId, $added);
            $student = $this->read($studentId, $permissions);
            $this->audit($request, 'student.updated', $student, $before, array_unique([...$currentBranches, ...$added]), $currentBranches, array_keys($changedCustomValues));

            return response()->json(['student' => $student]);
        });
    }

    public function updateSharing(Request $request, string $studentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId), 404);
        $data = $request->validate(['sharing_enabled' => ['required', 'boolean'], 'revision' => ['required', 'integer', 'min:1']]);

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $data, $studentId): JsonResponse {
            $row = DB::connection('tenant')->table('students')->where('id', $studentId)->lockForUpdate()->first();
            abort_unless($row, 404);
            $before = $this->read($studentId, $permissions);
            abort_unless($before['can_manage'], 403);
            $sharing = (bool) $data['sharing_enabled'];
            if ((bool) $row->sharing_enabled === $sharing) {
                return response()->json(['student' => $before]);
            }
            if ($row->revision !== (int) $data['revision']) {
                $this->conflict('student_changed');
            }
            DB::connection('tenant')->table('students')->where('id', $studentId)->update([
                'sharing_enabled' => $sharing, 'revision' => $row->revision + 1, 'updated_at' => now(),
            ]);
            $branches = DB::connection('tenant')->table('student_branches')->where('student_id', $studentId)->pluck('branch_id');
            foreach ($branches as $branchId) {
                DB::connection('tenant')->table('center_audit_logs')->insert([
                    'actor_id' => $request->user()->id, 'branch_id' => $branchId, 'event' => 'student.sharing_changed',
                    'details' => json_encode(['student_id' => $studentId, 'before' => ['sharing_enabled' => (bool) $row->sharing_enabled], 'after' => ['sharing_enabled' => $sharing]]),
                    'created_at' => now(),
                ]);
            }

            return response()->json(['student' => $this->read($studentId, $permissions)]);
        });
    }

    public function identityPreview(Request $request): JsonResponse
    {
        $data = $request->validate(['national_id' => ['required', 'string', 'max:14'], 'student_id' => ['nullable', 'uuid'], 'branch_ids' => ['present', 'array', 'max:50'], 'branch_ids.*' => ['integer', 'distinct'], 'date_of_birth' => ['nullable', 'date_format:Y-m-d']], ['national_id.*' => 'أدخل الرقم القومي كنص من 14 رقمًا.', 'date_of_birth.*' => 'أدخل تاريخ ميلاد صحيحًا بصيغة YYYY-MM-DD.']);

        return $this->write($request, function (CenterPermissions $permissions) use ($data): JsonResponse {
            $savedBirth = null;
            if (isset($data['student_id'])) {
                $student = $this->read($data['student_id'], $permissions);
                abort_unless($student['can_manage_identity'], 403);
                $savedBirth = $student['date_of_birth'];
            } else {
                $this->authorizeBranches($permissions, $data['branch_ids']);
                abort_unless(StudentIdentity::canManage($permissions, $data['branch_ids']), 403);
            }
            $birth = StudentIdentity::birthDate(trim($data['national_id']));
            $entered = $data['date_of_birth'] ?? null;

            return response()->json(['date_of_birth' => $birth, 'saved_date_of_birth' => $savedBirth, 'conflict' => ($entered !== null && $entered !== $birth) || ($savedBirth !== null && $savedBirth !== $birth)])
                ->header('Cache-Control', 'private, no-store');
        });
    }

    public function updateCodeSettings(Request $request): JsonResponse
    {
        $data = $request->validate(['enabled' => ['required', 'boolean'], 'label' => ['required', 'string', 'max:100'], 'revision' => ['required', 'integer', 'min:1']], ['label.*' => 'أدخل اسم الباركود الإضافي (حتى 100 حرف).']);

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $data): JsonResponse {
            abort_unless($permissions->isCenterManager(), 403);
            $settings = DB::connection('tenant')->table('center_settings')->where('id', 1)->lockForUpdate()->first();
            $value = ['student_code_enabled' => (bool) $data['enabled'], 'student_code_label' => trim($data['label'])];
            if ((bool) $settings->student_code_enabled !== $value['student_code_enabled'] || $settings->student_code_label !== $value['student_code_label']) {
                if ($settings->student_code_revision !== (int) $data['revision']) {
                    $this->conflict('student_code_settings_changed');
                }
                DB::connection('tenant')->table('center_settings')->where('id', 1)->update([...$value, 'student_code_revision' => $settings->student_code_revision + 1, 'updated_at' => now()]);
                DB::connection('tenant')->table('center_audit_logs')->insert(['actor_id' => $request->user()->id, 'event' => 'center.student_code_settings_changed', 'details' => json_encode(['before' => ['enabled' => (bool) $settings->student_code_enabled, 'label' => $settings->student_code_label], 'after' => ['enabled' => $value['student_code_enabled'], 'label' => $value['student_code_label']]]), 'created_at' => now()]);
            }

            return (new CenterSettingsController)->show($request);
        });
    }

    private function write(Request $request, Closure $operation): JsonResponse
    {
        return CenterWrites::run($request, $operation);
    }

    private function validateProfile(Request $request): array
    {
        $data = $request->validate([
            'custom_values' => ['sometimes', 'array', 'max:10000'],
            'custom_fields_revision' => ['sometimes', 'integer', 'min:1'],
            'national_id' => ['sometimes', 'nullable', 'string', 'max:14'],
            'passport_number' => ['sometimes', 'nullable', 'string', 'max:50'],
            'manual_code' => ['sometimes', 'nullable', 'string', 'max:50'],
            'name' => ['required', 'string', 'max:255'], 'phone' => ['nullable', 'string', 'max:50'],
            'branch_ids' => ['present', 'array', $request->isMethod('POST') ? 'min:1' : 'min:0', 'max:50'], 'branch_ids.*' => ['integer', 'distinct'],
            'status' => ['prohibited'], 'status_revision' => ['prohibited'],
            'student_number' => ['prohibited'], 'user_id' => ['prohibited'],
            'date_of_birth' => ['sometimes', 'nullable', 'date_format:Y-m-d', 'after_or_equal:0001-01-01', 'before_or_equal:today'],
            'gender' => ['sometimes', 'nullable', 'in:male,female'],
            'address' => ['sometimes', 'nullable', 'string', 'max:1000'],
            'email' => ['sometimes', 'nullable', 'email', 'max:255'],
            'school' => ['sometimes', 'nullable', 'string', 'max:255'],
            'employer' => ['sometimes', 'nullable', 'string', 'max:255'],
            ...array_fill_keys(StudentProfileChoices::fields(), ['sometimes', 'nullable', 'uuid']),
            'specialization' => ['sometimes', 'nullable', 'string', 'max:255'],
            ...StudentContacts::rules(),
        ], ['name.required' => 'أدخل اسم الطالب.', 'branch_ids.required' => 'اختر فرعًا مصرحًا به على الأقل.',
            'date_of_birth.*' => 'أدخل تاريخ ميلاد صحيحًا بصيغة YYYY-MM-DD لا يتجاوز اليوم.',
            'manual_code.*' => 'أدخل الباركود الإضافي كنص، حتى 50 حرفًا، مع الاحتفاظ بالأصفار والأحرف.',
            'national_id.*' => 'أدخل الرقم القومي كنص من 14 رقمًا.', 'passport_number.*' => 'أدخل رقم الجواز كنص، حتى 50 حرفًا.',
            'email.*' => 'أدخل بريدًا إلكترونيًا صحيحًا.', 'gender.*' => 'اختر ذكر أو أنثى.',
            'contacts.*.name.*' => 'أدخل اسم جهة التواصل (حتى 255 حرفًا).',
            'contacts.*.relationship.*' => 'أدخل صلة الجهة بالطالب (حتى 100 حرف).',
            'contacts.*.phone.*' => 'أدخل هاتف جهة التواصل كنص يحتوي أرقامًا (حتى 50 حرفًا).',
            'contacts.*.id.*' => 'جهة التواصل غير صالحة أو مكررة.',
            'contacts.*.primary.*' => 'حدد الجهة الأساسية.',
            'contacts.*' => 'أدخل قائمة جهات تواصل صحيحة، بحد أقصى 20 جهة.',
            'channels.*.phone.*' => 'أدخل رقم القناة كنص يحتوي أرقامًا (حتى 50 حرفًا).',
            'channels.*.contact_id.*' => 'اختر صاحب القناة من جهات هذا الطالب.',
            'channels.*' => 'حدد قنوات التواصل وأصحابها بصورة صحيحة.']);
        if (isset($data['custom_values'])) {
            $data['custom_values'] = array_map(fn ($value) => is_string($value) ? (trim($value) === '' ? null : trim($value)) : $value, $data['custom_values']);
            ksort($data['custom_values']);
        }
        if (array_key_exists('manual_code', $data)) {
            $data['manual_code'] = is_string($data['manual_code']) ? (trim($data['manual_code']) === '' ? null : trim($data['manual_code'])) : null;
        }
        foreach (StudentIdentity::FIELDS as $field) {
            if (array_key_exists($field, $data) && is_string($data[$field])) {
                $data[$field] = trim($data[$field]) === '' ? null : trim($data[$field]);
            }
        }
        $data['name'] = trim($data['name']);
        abort_if($data['name'] === '', 422, 'أدخل اسم الطالب.');
        $data['phone'] = isset($data['phone']) ? trim($data['phone']) : null;
        foreach (self::GENERAL_FIELDS as $field) {
            if (array_key_exists($field, $data) && is_string($data[$field])) {
                $data[$field] = trim($data[$field]) ?: null;
            }
        }
        $data['branch_ids'] = array_map('intval', $data['branch_ids']);
        sort($data['branch_ids']);

        return StudentContacts::normalize($data);
    }

    private function authorizeBranches(CenterPermissions $permissions, array $branchIds): void
    {
        foreach ($branchIds as $branchId) {
            abort_unless($permissions->can('students.manage', $branchId), 403);
        }
        abort_unless(DB::connection('tenant')->table('branches')->whereIn('id', $branchIds)->count() === count($branchIds), 403);
    }

    private function branchScope(CenterPermissions $permissions, string $action): array
    {
        return array_keys(array_filter($permissions->branchRoles, fn (array $roles): bool => in_array($action, CenterPermissions::actions($roles), true)));
    }

    private function visibleStudents(CenterPermissions $permissions, bool $includeCenterSearch = false, bool $includeIdentity = false): Builder
    {
        $associations = DB::connection('tenant')->table('student_branches')->whereColumn('student_id', 'students.id');
        if (! $permissions->isCenterManager()) {
            $associations->whereIn('branch_id', $this->branchScope($permissions, 'read'));
        }

        $identityBranches = array_intersect($this->branchScope($permissions, 'read'), $this->branchScope($permissions, 'students.identity'));
        $identityScope = $permissions->isCenterManager() ? 'true' : 'EXISTS (SELECT 1 FROM student_branches identity_branches WHERE identity_branches.student_id = students.id AND identity_branches.branch_id IN ('.(implode(',', array_map('intval', $identityBranches)) ?: 'NULL').'))';

        return DB::connection('tenant')->table('students')
            ->when($includeIdentity, fn (Builder $query) => $query->selectRaw("CASE WHEN {$identityScope} THEN json_build_object('national_id', national_id, 'passport_number', passport_number) ELSE NULL END AS identity"))
            ->addSelect(['students.id', 'student_number', 'manual_code', 'name', 'students.phone as legacy_phone', 'contacts', 'channels', 'revision', 'created_by', 'created_at', 'sharing_enabled', 'status', 'status_revision', ...self::GENERAL_FIELDS])
            ->selectRaw(StudentContacts::phoneSql().' as phone')
            ->selectSub(StudentProfileChoices::selectedQuery(), 'profile_choices')
            ->when($includeIdentity, fn (Builder $query) => $query->selectSub(StudentCustomFields::valuesQuery(), 'custom_values'))
            ->selectSub(StudentCustomFields::missingQuery(), 'missing_custom_fields')
            ->selectSub((clone $associations)->selectRaw('json_agg(branch_id ORDER BY branch_id)'), 'branch_ids')
            ->where(function (Builder $query) use ($associations, $permissions, $includeCenterSearch): void {
                $query->whereExists((clone $associations)->selectRaw('1'));
                if ($includeCenterSearch && CenterStudentSearchController::hasSearchPermission($permissions)) {
                    $query->orWhere(function (Builder $shared): void {
                        $shared->where('students.sharing_enabled', true)
                            ->whereExists(DB::connection('tenant')->table('student_search_policy')->where('id', 1)->where('enabled', true)->selectRaw('1'));
                    });
                }
            });
    }

    private function payload(stdClass $row, CenterPermissions $permissions): array
    {
        $branches = json_decode($row->branch_ids, true);

        return [...array_intersect_key((array) $row, array_flip(self::GENERAL_FIELDS)),
            ...(isset($row->identity) ? ['identity' => json_decode($row->identity, true)] : []),
            'can_read_identity' => StudentIdentity::canRead($permissions, $branches), 'can_manage_identity' => StudentIdentity::canManage($permissions, $branches),
            'contacts' => json_decode($row->contacts, true), 'channels' => json_decode($row->channels, true), 'legacy_phone' => $row->legacy_phone,
            'missing_custom_fields' => (int) $row->missing_custom_fields,
            ...(isset($row->custom_values) ? ['custom_values' => (object) (json_decode($row->custom_values, true) ?? [])] : []),
            'profile_choices' => json_decode($row->profile_choices ?? '{}', true) ?? [],
            'age' => $row->date_of_birth === null ? null : (int) CarbonImmutable::parse($row->date_of_birth)->diffInYears(CarbonImmutable::today()),
            'status' => $row->status, 'status_revision' => $row->status_revision, 'can_change_status' => $permissions->isCenterManager(),
            'created_by' => $row->created_by, 'created_at' => $row->created_at,
            'manual_code' => $row->manual_code,
            'id' => $row->id, 'student_number' => $row->student_number, 'name' => $row->name, 'phone' => $row->phone,
            'revision' => $row->revision, 'branch_ids' => $branches, 'sharing_enabled' => (bool) $row->sharing_enabled,
            'can_manage' => collect($branches)->contains(fn (int $id): bool => $permissions->can('students.manage', $id))];
    }

    private function read(string $id, CenterPermissions $permissions): array
    {
        $row = $this->visibleStudents($permissions, false, true)->where('students.id', $id)->first();
        abort_unless($row, 404);

        return $this->payload($row, $permissions);
    }

    private function associate(string $id, array $branchIds): void
    {
        foreach ($branchIds as $branchId) {
            DB::connection('tenant')->table('student_branches')->insertOrIgnore(['student_id' => $id, 'branch_id' => $branchId, 'created_at' => now()]);
        }
    }

    private function audit(Request $request, string $event, array $after, ?array $before, array $branchIds, array $previousBranchIds = [], array $customChangedFields = []): void
    {
        $basic = fn (?array $student): ?array => $student === null ? null : array_intersect_key($student, array_flip(['student_number', 'manual_code', 'name', 'phone', 'legacy_phone', 'contacts', 'channels', 'profile_choices', ...self::GENERAL_FIELDS]));
        $identityChanged = array_values(array_filter(StudentIdentity::FIELDS, fn (string $field): bool => ($before['identity'][$field] ?? null) !== ($after['identity'][$field] ?? null)));
        foreach ($branchIds as $branchId) {
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'branch_id' => $branchId, 'event' => $event,
                'details' => json_encode(['student_id' => $after['id'], 'before' => $basic($before), 'after' => $basic($after), 'identity_changed' => $identityChanged, 'custom_fields_changed' => $customChangedFields,
                    'associated_before' => in_array($branchId, $previousBranchIds, true), 'associated_after' => true]), 'created_at' => now(),
            ]);
        }
    }

    private function normalizeName(string $name): string
    {
        return mb_strtolower(preg_replace('/\s+/u', ' ', trim($name)));
    }

    private function normalizePhone(?string $phone): ?string
    {
        $value = preg_replace('/[^0-9]/', '', strtr($phone ?? '', array_combine(mb_str_split('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'), str_split('01234567890123456789'))));

        return $value === '' ? null : $value;
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
