<?php

namespace App\Support;

use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class StudentManualCodes
{
    public static function number(?string $code): ?string
    {
        return $code !== null && ctype_digit($code) ? (ltrim($code, '0') ?: '0') : null;
    }

    public static function identifiers(string $input): Builder
    {
        $number = self::number($input);

        return DB::connection('tenant')->table('students as identifiers')->select('identifiers.id')
            ->where(function (Builder $query) use ($input, $number): void {
                $query->where(function (Builder $manual) use ($input): void {
                    $manual->where('manual_code', $input)->whereExists(DB::connection('tenant')->table('center_settings')->where('id', 1)->where('student_code_enabled', true));
                });
                if ($number !== null && strlen($number) <= 18) {
                    $query->orWhere('student_number', $number);
                }
            });
    }

    public static function validate(?string $code, ?string $studentId = null): void
    {
        if ($code === null && $studentId === null) {
            return;
        }
        if (! DB::connection('tenant')->table('center_settings')->where('id', 1)->value('student_code_enabled')) {
            throw ValidationException::withMessages(['manual_code' => 'الباركود الإضافي غير مفعل. قيمته السابقة محفوظة.']);
        }
        if ($code === null) {
            return;
        }
        $number = self::number($code);
        $conflict = DB::connection('tenant')->table('students')->when($studentId, fn ($query) => $query->where('id', '!=', $studentId))
            ->where(function ($query) use ($code, $number): void {
                $query->where('manual_code', $code);
                if ($number !== null) {
                    $query->orWhereRaw('student_number::text = ?', [$number]);
                }
            })->exists();
        if ($conflict) {
            throw ValidationException::withMessages(['manual_code' => 'الرمز غير متاح داخل المركز. اختر رمزًا آخر.']);
        }
    }

    public static function validateAllocation(int $number): void
    {
        // Disabled codes stay reserved so re-enabling can never make an existing card ambiguous.
        if (DB::connection('tenant')->table('students')->where('manual_code_number', (string) $number)->exists()) {
            throw new HttpResponseException(response()->json(['code' => 'student_number_code_collision', 'message' => 'الرقم التالي يتعارض مع باركود إضافي محفوظ. راجع مسؤول المركز لتعديل الرمز أو بداية التسلسل؛ لم يُنشأ الملف ولم تتغير أرقام الطلاب.'], 409));
        }
    }
}
