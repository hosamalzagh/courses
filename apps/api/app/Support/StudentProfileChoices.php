<?php

namespace App\Support;

use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use stdClass;

class StudentProfileChoices
{
    public const KINDS = ['city', 'qualification', 'profession', 'collection_method', 'discovery_source'];

    public static function fields(): array
    {
        return array_map(fn ($kind) => $kind.'_id', self::KINDS);
    }

    // One bounded page per kind, composed into the existing workspace SQL.
    public static function initialQuery(): Builder
    {
        $union = null;
        foreach (self::KINDS as $kind) {
            $page = DB::connection('tenant')->table('student_profile_choices')->where('kind', $kind)->where('active', true)
                ->orderBy('position')->orderBy('id')->limit(51)->select(['id', 'kind', 'label', 'active', 'position', 'revision']);
            $union = $union ? $union->unionAll($page) : $page;
        }

        return DB::connection('tenant')->query()->fromSub($union, 'choices')->selectRaw('json_agg(choices ORDER BY kind, position, id)');
    }

    public static function selectedQuery(): Builder
    {
        return DB::connection('tenant')->table('student_profile_choices')->where(function (Builder $query): void {
            foreach (self::KINDS as $kind) {
                $query->orWhereColumn('student_profile_choices.id', 'students.'.$kind.'_id');
            }
        })->selectRaw("json_object_agg(kind, json_build_object('id', id, 'kind', kind, 'label', label, 'active', active, 'position', position, 'revision', revision))");
    }

    public static function validate(array $data, ?stdClass $student = null): void
    {
        $ids = array_filter(array_intersect_key($data, array_flip(self::fields())));
        if ($ids === []) {
            return;
        }
        $choices = DB::connection('tenant')->table('student_profile_choices')->whereIn('id', $ids)->lockForUpdate()->get()->keyBy('id');
        foreach (self::KINDS as $kind) {
            $field = $kind.'_id';
            if (! isset($data[$field])) {
                continue;
            }
            $choice = $choices->get($data[$field]);
            if (! $choice || $choice->kind !== $kind || (! $choice->active && $student?->{$field} !== $choice->id)) {
                throw ValidationException::withMessages([$field => 'الاختيار غير متاح. اختر قيمة نشطة من قائمة المركز.']);
            }
        }
    }
}
