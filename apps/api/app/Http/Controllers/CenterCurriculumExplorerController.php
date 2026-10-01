<?php

namespace App\Http\Controllers;

use App\Support\CurriculumExplorerRead;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class CenterCurriculumExplorerController extends Controller
{
    public function workspace(Request $request): JsonResponse
    {
        $data = $request->validate([
            'courses_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'kind' => ['required_with:id', 'in:course,stage,level,group'], 'id' => ['required_with:kind', 'uuid'],
            'expanded' => ['sometimes', 'string', 'max:1300', function ($attribute, $value, $fail) {
                $entries = explode(',', $value);
                if (count($entries) > 20 || collect($entries)->contains(fn ($entry) => ! preg_match('/^(course|stage|level):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:([1-9][0-9]{0,4}|100000)$/i', $entry))) {
                    $fail('حالة الشجرة غير صالحة. افتح المنهج من القائمة.');
                }
            }],
            'q' => ['sometimes', 'nullable', 'string', 'max:80'],
            'search_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'plan_version' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'versions_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'groups_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'levels_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'stages_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'branches_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'course_id' => ['sometimes', 'uuid'], 'stage_id' => ['sometimes', 'uuid'],
            'students_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'sessions_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        $workspace = (new CurriculumExplorerRead($permissions))->workspace($data);

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(),
            ...$workspace,
        ])->header('Cache-Control', 'private, no-store');
    }

    public function children(Request $request): JsonResponse
    {
        $data = $request->validate([
            'kind' => ['required', 'in:course,stage,level'], 'id' => ['required', 'uuid'],
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
        ]);
        $read = new CurriculumExplorerRead($request->attributes->get('center_permissions'));
        $page = (int) ($data['page'] ?? 1);
        $childKind = ['course' => 'stage', 'stage' => 'level', 'level' => 'group'][$data['kind']];
        $parent = $read->nodes($data['kind'])->where(CurriculumExplorerRead::table($data['kind']).'.id', $data['id'])->limit(1);
        $children = $read->children($data['kind'], $data['id'])
            ->orderBy(CurriculumExplorerRead::table($childKind).'.created_at')->orderBy(CurriculumExplorerRead::table($childKind).'.id')
            ->offset(($page - 1) * 50)->limit(51);
        $rows = CurriculumExplorerRead::tagged($parent, 'parent')->unionAll(CurriculumExplorerRead::tagged($children, 'child'))->get();
        $parentRow = $rows->firstWhere('record_kind', 'parent');
        abort_unless($parentRow, 404);
        $items = $rows->where('record_kind', 'child');

        return response()->json(['batch' => [
            'parent' => $read->present(json_decode($parentRow->payload)),
            'items' => $items->take(50)->map(fn ($row) => $read->present(json_decode($row->payload)))->values(),
            'page' => $page, 'has_more' => $items->count() > 50,
        ]])->header('Cache-Control', 'private, no-store');
    }
}
