<?php

namespace App\Support;

use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class StudentCustomFields
{
    public const TYPES = ['text', 'number', 'date', 'select', 'boolean'];

    public static function pageQuery(int $page = 1): Builder
    {
        return DB::connection('tenant')->table('student_custom_fields')->orderBy('position')->orderBy('id')
            ->offset(($page - 1) * 50)->limit(51)->select(['id', 'label', 'type', 'required', 'position', 'options', 'revision']);
    }

    public static function initialQuery(): Builder
    {
        return DB::connection('tenant')->query()->fromSub(self::pageQuery(), 'fields')->selectRaw('json_agg(fields ORDER BY position, id)');
    }

    public static function valuesQuery(int $page = 1): Builder
    {
        return DB::connection('tenant')->table('student_custom_field_values')->whereColumn('student_id', 'students.id')
            ->whereIn('field_id', self::pageQuery($page)->limit(50)->select('id'))->selectRaw('json_object_agg(field_id, value)');
    }

    public static function missingQuery(): Builder
    {
        return DB::connection('tenant')->table('student_custom_fields')->where('required', true)
            ->whereNotExists(DB::connection('tenant')->table('student_custom_field_values')->whereColumn('field_id', 'student_custom_fields.id')->whereColumn('student_id', 'students.id')->selectRaw('1'))->selectRaw('count(*)');
    }

    public static function validate(array $data, ?string $studentId = null): array
    {
        if (isset($data['custom_fields_revision']) && (int) $data['custom_fields_revision'] !== (int) DB::connection('tenant')->table('center_settings')->where('id', 1)->value('student_custom_fields_revision')) {
            self::conflict();
        }
        $supplied = $data['custom_values'] ?? [];
        foreach (array_keys($supplied) as $id) {
            if (! Str::isUuid($id)) {
                throw ValidationException::withMessages(['custom_values' => 'اختر حقولًا من تعريفات هذا المركز.']);
            }
        }
        $fields = DB::connection('tenant')->table('student_custom_fields')->where(fn ($query) => $query->where('required', true)->orWhereIn('id', array_keys($supplied)))->get()->keyBy('id');
        $stored = $studentId ? DB::connection('tenant')->table('student_custom_field_values')->where('student_id', $studentId)->pluck('value', 'field_id')->map(fn ($value) => json_decode($value, true))->all() : [];
        $values = [];
        $errors = [];
        foreach ($supplied as $id => $value) {
            $field = $fields->get($id);
            $key = 'custom_values.'.$id;
            if (! $field) {
                $errors[$key] = 'الحقل غير متاح في هذا المركز.';

                continue;
            }
            if (is_string($value)) {
                $value = trim($value);
            }
            if ($value === null || $value === '') {
                $values[$id] = null;

                continue;
            }
            $valid = match ($field->type) {
                'text' => is_string($value) && mb_strlen($value) <= 1000,
                'number' => is_string($value) && preg_match('/^-?\d{1,20}(?:\.\d{1,10})?$/D', $value),
                'date' => is_string($value) && preg_match('/^\d{4}-\d{2}-\d{2}$/D', $value) && (int) substr($value, 0, 4) > 0 && checkdate((int) substr($value, 5, 2), (int) substr($value, 8, 2), (int) substr($value, 0, 4)),
                'select' => is_string($value) && in_array($value, json_decode($field->options, true), true),
                'boolean' => is_bool($value),
            };
            if (! $valid) {
                $errors[$key] = 'أدخل قيمة صحيحة حسب نوع الحقل وخياراته.';
            } else {
                $values[$id] = $value;
            }
        }
        $merged = array_replace($stored, $values);
        foreach ($fields as $field) {
            if ($field->required && (! array_key_exists($field->id, $merged) || $merged[$field->id] === null || $merged[$field->id] === '')) {
                $errors['custom_values.'.$field->id] = 'هذا الحقل مطلوب. حمّل بقية الحقول إذا لم يظهر في الدفعة الحالية.';
            }
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }

        return $values;
    }

    public static function save(string $studentId, array $values): void
    {
        foreach ($values as $id => $value) {
            if ($value === null) {
                DB::connection('tenant')->table('student_custom_field_values')->where('student_id', $studentId)->where('field_id', $id)->delete();
            } else {
                DB::connection('tenant')->table('student_custom_field_values')->upsert([['student_id' => $studentId, 'field_id' => $id, 'value' => json_encode($value), 'updated_at' => now(), 'created_at' => now()]], ['student_id', 'field_id'], ['value', 'updated_at']);
            }
        }
    }

    public static function conflict(): never
    {
        throw new HttpResponseException(response()->json(['code' => 'student_custom_fields_changed', 'message' => 'تغيرت تعريفات الحقول. حمّل التعريفات الحالية لمراجعتها؛ مدخلاتك محفوظة.'], 409));
    }
}
