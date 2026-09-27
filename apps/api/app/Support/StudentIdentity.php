<?php

namespace App\Support;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use stdClass;

class StudentIdentity
{
    public const FIELDS = ['national_id', 'passport_number'];

    public static function readableBranches(CenterPermissions $permissions): array
    {
        return array_values(array_filter(array_keys($permissions->branchRoles), fn (int $id): bool => $permissions->can('read', $id) && $permissions->can('students.identity', $id)));
    }

    public static function canRead(CenterPermissions $permissions, array $branches): bool
    {
        return collect($branches)->contains(fn (int $id): bool => $permissions->can('read', $id) && $permissions->can('students.identity', $id));
    }

    public static function canManage(CenterPermissions $permissions, array $branches): bool
    {
        return collect($branches)->contains(fn (int $id): bool => $permissions->can('students.manage', $id) && $permissions->can('students.identity', $id));
    }

    public static function authorize(array $data, CenterPermissions $permissions, array $branches): void
    {
        if (array_intersect(self::FIELDS, array_keys($data)) !== []) {
            abort_unless(self::canManage($permissions, $branches), 403);
        }
    }

    public static function birthDate(string $number): string
    {
        if (! preg_match('/^[23][0-9]{13}$/D', $number)) {
            throw ValidationException::withMessages(['national_id' => 'أدخل رقمًا قوميًّا مصريًّا من 14 رقمًا يبدأ بالقرن 2 أو 3.']);
        }
        $year = ($number[0] === '2' ? 1900 : 2000) + (int) substr($number, 1, 2);
        $month = (int) substr($number, 3, 2);
        $day = (int) substr($number, 5, 2);
        if (! checkdate($month, $day, $year)) {
            throw ValidationException::withMessages(['national_id' => 'الرقم القومي يتضمن تاريخ ميلاد غير ممكن.']);
        }
        $date = sprintf('%04d-%02d-%02d', $year, $month, $day);
        if ($date > Carbon::today()->toDateString()) {
            throw ValidationException::withMessages(['national_id' => 'الرقم القومي يتضمن تاريخ ميلاد مستقبليًّا.']);
        }

        return $date;
    }

    public static function columns(array $data, CenterPermissions $permissions, array $branches, ?stdClass $current = null): array
    {
        self::authorize($data, $permissions, $branches);
        $columns = array_intersect_key($data, array_flip(self::FIELDS));
        $number = array_key_exists('national_id', $columns) ? $columns['national_id'] : ($current?->national_id);
        $birth = array_key_exists('date_of_birth', $data) ? $data['date_of_birth'] : ($current?->date_of_birth);
        if ($number !== null && ($current === null || $number !== $current->national_id || $birth !== $current->date_of_birth)) {
            $extracted = self::birthDate($number);
            if ($birth !== $extracted) {
                throw ValidationException::withMessages(['date_of_birth' => 'راجع تعارض تاريخ الميلاد مع بيانات الهوية قبل الحفظ؛ لم يُغيّر التاريخ المحفوظ.']);
            }
        }
        if ($number !== null && ($current === null || $number !== $current->national_id)
            && DB::connection('tenant')->table('students')->where('national_id', $number)->when($current, fn ($query) => $query->where('id', '!=', $current->id))->exists()) {
            throw ValidationException::withMessages(['national_id' => 'بيانات الهوية غير متاحة للتسجيل داخل المركز. راجع الإدخال أو مسؤول المركز.']);
        }

        return $columns;
    }
}
