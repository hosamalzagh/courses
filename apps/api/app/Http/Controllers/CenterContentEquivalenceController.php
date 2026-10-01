<?php

namespace App\Http\Controllers;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Support\CenterPermissions;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterContentEquivalenceController extends Controller
{
    public function workspace(Request $request): JsonResponse
    {
        $data = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'q' => ['nullable', 'string', 'max:100'],
            'options_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'options_q' => ['nullable', 'string', 'max:100'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        $visible = $this->visibleBranches($permissions);
        $optionsPage = (int) ($data['options_page'] ?? 1);
        $optionQuery = trim($data['options_q'] ?? '');
        $historyQuery = trim($data['q'] ?? '');
        $options = $this->plans()->when(! $permissions->isCenterManager(), fn (Builder $builder) => $builder->whereIn('courses.branch_id', $visible));
        if ($optionQuery !== '') {
            $options->where(function (Builder $builder) use ($optionQuery): void {
                $builder->where('levels.name', 'ilike', '%'.$optionQuery.'%')
                    ->orWhere('courses.name', 'ilike', '%'.$optionQuery.'%')
                    ->orWhere('stages.name', 'ilike', '%'.$optionQuery.'%');
                if (ctype_digit($optionQuery) && strlen($optionQuery) <= 9) {
                    $builder->orWhere('plans.version', (int) $optionQuery);
                }
            });
        }
        $optionRows = $options->orderByDesc('plans.created_at')->orderByDesc('plans.version')->orderByDesc('plans.id')
            ->offset(($optionsPage - 1) * 30)->limit(31)->get();
        $page = (int) ($data['page'] ?? 1);
        $approvalRows = DB::connection('tenant')->table('content_equivalences as approvals')
            ->join('study_plan_versions as source_plans', 'source_plans.id', '=', 'approvals.source_plan_version_id')
            ->join('levels as source_levels', 'source_levels.id', '=', 'source_plans.level_id')
            ->join('stages as source_stages', 'source_stages.id', '=', 'source_levels.stage_id')
            ->join('courses as source_courses', 'source_courses.id', '=', 'source_stages.course_id')
            ->join('study_plan_versions as target_plans', 'target_plans.id', '=', 'approvals.target_plan_version_id')
            ->join('levels as target_levels', 'target_levels.id', '=', 'target_plans.level_id')
            ->join('stages as target_stages', 'target_stages.id', '=', 'target_levels.stage_id')
            ->join('courses as target_courses', 'target_courses.id', '=', 'target_stages.course_id')
            ->when(! $permissions->isCenterManager(), fn (Builder $builder) => $builder
                ->whereIn('source_courses.branch_id', $visible)->whereIn('target_courses.branch_id', $visible))
            ->tap(fn (Builder $query) => $permissions->workspace?->constrain($query, 'source_courses.branch_id'))
            ->when($historyQuery !== '', fn (Builder $builder) => $builder->where(function (Builder $search) use ($historyQuery): void {
                foreach (['approvals.reason', 'approvals.approved_by_name', 'source_levels.name',
                    'target_levels.name', 'source_courses.name', 'target_courses.name'] as $column) {
                    $search->orWhere($column, 'ilike', '%'.$historyQuery.'%');
                }
            }))
            ->select(['approvals.id', 'approvals.source_plan_version_id', 'approvals.target_plan_version_id',
                'approvals.source_lecture_ids', 'approvals.target_lecture_ids', 'approvals.reason',
                'approvals.approved_by_id', 'approvals.approved_by_name', 'approvals.approved_at',
                'source_courses.branch_id as source_branch_id', 'target_courses.branch_id as target_branch_id',
                'source_levels.name as source_level_name', 'target_levels.name as target_level_name',
                'source_plans.version as source_version', 'target_plans.version as target_version'])
            ->selectRaw(<<<'SQL'
(SELECT COALESCE(json_agg(json_build_object('number', lectures.number, 'content', lectures.content, 'title', lectures.title)
    ORDER BY lectures.number), '[]'::json) FROM plan_lectures AS lectures
    WHERE lectures.plan_version_id = approvals.source_plan_version_id
    AND jsonb_exists(approvals.source_lecture_ids, lectures.id::text)) AS source_lectures,
(SELECT COALESCE(json_agg(json_build_object('number', lectures.number, 'content', lectures.content, 'title', lectures.title)
    ORDER BY lectures.number), '[]'::json) FROM plan_lectures AS lectures
    WHERE lectures.plan_version_id = approvals.target_plan_version_id
    AND jsonb_exists(approvals.target_lecture_ids, lectures.id::text)) AS target_lectures
SQL)
            ->orderByDesc('approvals.approved_at')->orderByDesc('approvals.id')
            ->offset(($page - 1) * 20)->limit(21)->get();

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(),
            'branches' => [],
            'options' => $optionRows->take(30)->map(fn (object $row): array => $this->option($row))->values(),
            'options_has_more' => $optionRows->count() > 30,
            'options_page' => $optionsPage,
            'approvals' => $approvalRows->take(20)->map(fn (object $row): array => [
                ...(array) $row,
                'source_lecture_ids' => json_decode($row->source_lecture_ids, true),
                'target_lecture_ids' => json_decode($row->target_lecture_ids, true),
                'source_lectures' => json_decode($row->source_lectures, true),
                'target_lectures' => json_decode($row->target_lectures, true),
            ])->values(),
            'pagination' => ['page' => $page, 'has_more' => $approvalRows->count() > 20],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request): JsonResponse
    {
        $data = $request->validate([
            'source_plan_version_id' => ['required', 'uuid', 'different:target_plan_version_id'],
            'target_plan_version_id' => ['required', 'uuid'],
            'source_lecture_ids' => ['required', 'array', 'min:1', 'max:200'],
            'source_lecture_ids.*' => ['required', 'uuid', 'distinct'],
            'target_lecture_ids' => ['required', 'array', 'min:1', 'max:200'],
            'target_lecture_ids.*' => ['required', 'uuid', 'distinct'],
            'reason' => ['required', 'string', 'min:5', 'max:1000'],
            'request_id' => ['required', 'uuid'],
        ]);
        $sourceIds = array_values($data['source_lecture_ids']);
        $targetIds = array_values($data['target_lecture_ids']);
        sort($sourceIds);
        sort($targetIds);
        $reason = trim($data['reason']);
        abort_if(mb_strlen($reason) < 5, 422, 'اكتب سبب الاعتماد بوضوح.');
        $mappingHash = hash('sha256', json_encode([$data['source_plan_version_id'], $sourceIds,
            $data['target_plan_version_id'], $targetIds]));
        $requestHash = hash('sha256', json_encode([$mappingHash, $reason]));

        return DB::connection('central')->transaction(function () use ($request, $data, $sourceIds, $targetIds, $reason, $mappingHash, $requestHash): JsonResponse {
            // Serialize approvals for this center before the idempotency and mapping lookups.
            $center = Center::query()->whereKey($request->attributes->get('center')->id)->lockForUpdate()->firstOrFail();
            abort_if($center->suspended, 423);
            abort_unless($center->provisioning_status === 'active', 503);
            abort_unless(CenterMembership::query()->where('tenant_id', $center->id)
                ->where('user_id', $request->user()->id)->value('status') === 'active', 403);

            return DB::connection('tenant')->transaction(function () use ($request, $data, $sourceIds, $targetIds, $reason, $mappingHash, $requestHash): JsonResponse {
                $permissions = CenterPermissions::forUser($request->user()->id);
                $plans = $this->plans()->whereIn('plans.id', [$data['source_plan_version_id'], $data['target_plan_version_id']])
                    ->get()->keyBy('id');
                $source = $plans->get($data['source_plan_version_id']);
                $target = $plans->get($data['target_plan_version_id']);
                abort_unless($source && $target && $permissions->canInWorkspace('read', (int) $source->branch_id)
                    && $permissions->can('read', (int) $target->branch_id), 404);
                abort_unless($permissions->canInWorkspace('content.equivalence', (int) $source->branch_id)
                    && $permissions->can('content.equivalence', (int) $target->branch_id), 403);
                $knownSource = array_column(json_decode($source->lectures, true), 'id');
                $knownTarget = array_column(json_decode($target->lectures, true), 'id');
                abort_unless(count(array_diff($sourceIds, $knownSource)) === 0
                    && count(array_diff($targetIds, $knownTarget)) === 0, 422, 'اختر محاضرات كاملة من الإصدارين المحددين.');
                $prior = DB::connection('tenant')->table('content_equivalences')->where('request_id', $data['request_id'])->first();
                if ($prior) {
                    abort_unless((int) $prior->approved_by_id === (int) $request->user()->id, 403);
                    if ($prior->request_hash !== $requestHash) {
                        $this->conflict('equivalence_request_changed');
                    }

                    return response()->json(['approval' => $this->record($prior), 'replayed' => true]);
                }
                if (DB::connection('tenant')->table('content_equivalences')->where('mapping_hash', $mappingHash)->exists()) {
                    $this->conflict('equivalence_already_approved');
                }
                $id = (string) Str::uuid();
                $time = now();
                $record = [
                    'id' => $id, 'source_plan_version_id' => $source->id,
                    'target_plan_version_id' => $target->id,
                    'source_lecture_ids' => json_encode($sourceIds), 'target_lecture_ids' => json_encode($targetIds),
                    'reason' => $reason, 'approved_by_id' => $request->user()->id,
                    'approved_by_name' => $request->user()->name, 'approved_at' => $time,
                    'request_id' => $data['request_id'], 'request_hash' => $requestHash,
                    'mapping_hash' => $mappingHash,
                ];
                DB::connection('tenant')->table('study_plan_versions')
                    ->whereIn('id', [$source->id, $target->id])->whereNull('used_at')->update(['used_at' => $time]);
                DB::connection('tenant')->table('content_equivalences')->insert($record);
                $sourceLectures = array_values(array_filter(json_decode($source->lectures, true),
                    fn (array $lecture): bool => in_array($lecture['id'], $sourceIds, true)));
                $targetLectures = array_values(array_filter(json_decode($target->lectures, true),
                    fn (array $lecture): bool => in_array($lecture['id'], $targetIds, true)));
                foreach (array_unique([(int) $source->branch_id, (int) $target->branch_id]) as $branchId) {
                    $local = [];
                    if ($branchId === (int) $source->branch_id) {
                        $local['source'] = ['plan_version_id' => $source->id, 'lecture_ids' => $sourceIds,
                            'lectures' => $sourceLectures];
                    }
                    if ($branchId === (int) $target->branch_id) {
                        $local['target'] = ['plan_version_id' => $target->id, 'lecture_ids' => $targetIds,
                            'lectures' => $targetLectures];
                    }
                    DB::connection('tenant')->table('center_audit_logs')->insert([
                        'actor_id' => $request->user()->id, 'branch_id' => $branchId,
                        'event' => 'content.equivalence_approved',
                        'details' => json_encode(['kind' => 'content_equivalences', 'record_id' => $id,
                            'before' => null, 'after' => $local, 'reason' => $reason]),
                        'created_at' => $time,
                    ]);
                }

                return response()->json(['approval' => $this->record((object) $record)], 201);
            });
        });
    }

    private function plans(): Builder
    {
        return DB::connection('tenant')->table('study_plan_versions as plans')
            ->join('levels', 'levels.id', '=', 'plans.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->join('branches', 'branches.id', '=', 'courses.branch_id')
            ->select(['plans.id', 'plans.version', 'levels.id as level_id', 'levels.name as level_name',
                'stages.name as stage_name', 'courses.name as course_name', 'courses.branch_id',
                'branches.name as branch_name'])
            ->selectRaw(<<<'SQL'
COALESCE((SELECT json_agg(json_build_object('id', lectures.id, 'number', lectures.number,
    'content', lectures.content, 'title', lectures.title, 'planned_hours', lectures.planned_hours::float)
    ORDER BY lectures.number) FROM plan_lectures AS lectures WHERE lectures.plan_version_id = plans.id), '[]'::json) AS lectures
SQL);
    }

    private function option(object $row): array
    {
        return [...(array) $row, 'lectures' => json_decode($row->lectures, true)];
    }

    private function record(object $row): array
    {
        return ['id' => $row->id, 'source_plan_version_id' => $row->source_plan_version_id,
            'target_plan_version_id' => $row->target_plan_version_id,
            'source_lecture_ids' => json_decode($row->source_lecture_ids, true),
            'target_lecture_ids' => json_decode($row->target_lecture_ids, true),
            'reason' => $row->reason, 'approved_by_id' => (int) $row->approved_by_id,
            'approved_by_name' => $row->approved_by_name, 'approved_at' => $row->approved_at];
    }

    private function visibleBranches(CenterPermissions $permissions): array
    {
        return array_keys(array_filter($permissions->branchRoles,
            fn (array $roles): bool => in_array('read', CenterPermissions::actions($roles), true)));
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
