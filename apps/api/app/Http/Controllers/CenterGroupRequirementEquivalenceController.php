<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterGroupRequirementEquivalenceController extends Controller
{
    public function options(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $data = $request->validate([
            'required_requirement_id' => ['required', 'uuid'],
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'q' => ['nullable', 'string', 'max:100'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        $group = $this->group($groupId, $permissions, false, $data['required_requirement_id']);
        abort_unless($permissions->can('curriculum.manage', (int) $group->branch_id), 403);
        abort_unless($group->required_requirement !== null, 404);
        $required = json_decode($group->required_requirement);
        $page = (int) ($data['page'] ?? 1);
        $search = trim($data['q'] ?? '');
        $branches = array_keys(array_filter($permissions->branchRoles,
            fn (array $roles): bool => in_array('curriculum.manage', CenterPermissions::actions($roles), true)));
        $rows = DB::connection('tenant')->table('study_group_requirements as candidates')
            ->join('study_groups as groups', 'groups.id', '=', 'candidates.group_id')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->leftJoin('study_group_requirement_equivalences as approvals', function ($join) use ($required): void {
                $join->on('approvals.candidate_requirement_id', '=', 'candidates.id')
                    ->where('approvals.required_requirement_id', $required->id)
                    ->whereNull('approvals.revoked_at');
            })
            ->where('groups.level_id', $group->level_id)->where('groups.id', '<>', $groupId)
            ->whereNull('candidates.plan_lecture_id')->whereNull('candidates.retired_at')
            ->when(! $permissions->isCenterManager(), fn ($query) => $query->whereIn('courses.branch_id', $branches))
            ->when($search !== '', fn ($query) => $query->where(function ($matches) use ($search): void {
                $matches->where('groups.name', 'ilike', '%'.$search.'%')
                    ->orWhere('candidates.content', 'ilike', '%'.$search.'%');
                if (ctype_digit($search) && strlen($search) <= 9) {
                    $matches->orWhere('candidates.number', (int) $search);
                }
            }))
            ->select(['candidates.id', 'candidates.number', 'candidates.content', 'candidates.title',
                'groups.id as group_id', 'groups.name as group_name', 'groups.revision as group_revision',
                'approvals.id as approval_id', 'approvals.revision as approval_revision'])
            ->orderBy('groups.name')->orderBy('candidates.number')->orderBy('candidates.id')
            ->offset(($page - 1) * 20)->limit(21)->get();

        return response()->json(['group_revision' => (int) $group->revision, 'required' => $required,
            'candidates' => $rows->take(20),
            'pagination' => ['page' => $page, 'has_more' => $rows->count() > 20]])
            ->header('Cache-Control', 'private, no-store');
    }

    public function approve(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $data = $request->validate([
            'required_requirement_id' => ['required', 'uuid'],
            'candidate_requirement_id' => ['required', 'uuid', 'different:required_requirement_id'],
            'required_group_revision' => ['required', 'integer', 'min:1'],
            'candidate_group_revision' => ['required', 'integer', 'min:1'],
            'reason' => ['required', 'string', 'min:3', 'max:1000'],
            'request_id' => ['required', 'uuid'],
        ]);
        $data['reason'] = trim($data['reason']);
        abort_if(mb_strlen($data['reason']) < 3, 422, 'سبب اعتماد التكافؤ مطلوب.');
        $hash = hash('sha256', json_encode([$groupId, $data]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $groupId, $data, $hash): JsonResponse {
            $db = DB::connection('tenant');
            $candidateGroupId = $db->table('study_group_requirements')
                ->where('id', $data['candidate_requirement_id'])->value('group_id');
            abort_unless($candidateGroupId && $candidateGroupId !== $groupId, 404);
            $groups = collect([$groupId, $candidateGroupId])->sort()->mapWithKeys(
                fn (string $id): array => [$id => $this->group($id, $permissions, true)]);
            $requiredGroup = $groups[$groupId];
            $candidateGroup = $groups[$candidateGroupId];
            abort_unless($permissions->can('curriculum.manage', (int) $requiredGroup->branch_id)
                && $permissions->can('curriculum.manage', (int) $candidateGroup->branch_id), 403);
            $prior = $db->table('study_group_requirement_equivalences')
                ->where('request_id', $data['request_id'])->first();
            if ($prior) {
                abort_unless($prior->required_group_id === $groupId
                    && (int) $prior->approved_by === (int) $request->user()->id, 403);
                if ($prior->request_hash !== $hash) {
                    $this->conflict('requirement_equivalence_request_changed');
                }

                return response()->json(['approval' => $this->record($prior), 'replayed' => true])
                    ->header('Cache-Control', 'private, no-store');
            }
            abort_unless($requiredGroup->level_id === $candidateGroup->level_id, 422,
                'الاعتماد بين متطلبات المستوى نفسه فقط.');
            if ((int) $requiredGroup->revision !== (int) $data['required_group_revision']
                || (int) $candidateGroup->revision !== (int) $data['candidate_group_revision']) {
                $this->conflict('requirement_group_changed');
            }
            $requirements = $db->table('study_group_requirements')
                ->whereIn('id', [$data['required_requirement_id'], $data['candidate_requirement_id']])
                ->whereNull('plan_lecture_id')->whereNull('retired_at')->get(['id', 'group_id'])->keyBy('id');
            abort_unless($requirements->count() === 2
                && $requirements[$data['required_requirement_id']]->group_id === $groupId
                && $requirements[$data['candidate_requirement_id']]->group_id === $candidateGroupId, 404);
            if ($db->table('study_group_requirement_equivalences')
                ->where('required_requirement_id', $data['required_requirement_id'])
                ->where('candidate_requirement_id', $data['candidate_requirement_id'])
                ->whereNull('revoked_at')->exists()) {
                $this->conflict('requirement_equivalence_exists');
            }
            $actor = $request->user();
            $now = now();
            $approval = ['id' => (string) Str::uuid(),
                'required_requirement_id' => $data['required_requirement_id'],
                'candidate_requirement_id' => $data['candidate_requirement_id'],
                'required_group_id' => $groupId, 'candidate_group_id' => $candidateGroupId,
                'approved_by' => $actor->id, 'approved_by_name' => $actor->name,
                'reason' => $data['reason'], 'approved_at' => $now, 'revision' => 1,
                'request_id' => $data['request_id'], 'request_hash' => $hash];
            $db->table('study_group_requirement_equivalences')->insert($approval);
            $this->audit($actor->id, [$requiredGroup->branch_id, $candidateGroup->branch_id],
                'study_group.requirement_equivalence_approved', [
                    'id' => $approval['id'], 'required_group_id' => $groupId,
                    'candidate_group_id' => $candidateGroupId,
                    'required_requirement_id' => $data['required_requirement_id'],
                    'candidate_requirement_id' => $data['candidate_requirement_id'],
                    'reason' => $data['reason'], 'request_id' => $data['request_id'],
                ]);

            return response()->json(['approval' => $this->record((object) $approval)], 201)
                ->header('Cache-Control', 'private, no-store');
        });
    }

    public function revoke(Request $request, string $groupId, string $approvalId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId) && Str::isUuid($approvalId), 404);
        $data = $request->validate([
            'revision' => ['required', 'integer', 'min:1'],
            'reason' => ['required', 'string', 'min:3', 'max:1000'],
            'request_id' => ['required', 'uuid'],
        ]);
        $data['reason'] = trim($data['reason']);
        abort_if(mb_strlen($data['reason']) < 3, 422, 'سبب سحب التكافؤ مطلوب.');
        $hash = hash('sha256', json_encode([$groupId, $approvalId, $data]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $groupId, $approvalId, $data, $hash): JsonResponse {
            $db = DB::connection('tenant');
            $context = $db->table('study_group_requirement_equivalences')
                ->where('id', $approvalId)->where('required_group_id', $groupId)->first(['candidate_group_id']);
            abort_unless($context, 404);
            $groups = collect([$groupId, $context->candidate_group_id])->sort()->mapWithKeys(
                fn (string $id): array => [$id => $this->group($id, $permissions, true)]);
            abort_unless($permissions->can('curriculum.manage', (int) $groups[$groupId]->branch_id)
                && $permissions->can('curriculum.manage', (int) $groups[$context->candidate_group_id]->branch_id), 403);
            $approval = $db->table('study_group_requirement_equivalences')->where('id', $approvalId)
                ->lockForUpdate()->first();
            abort_unless($approval, 404);
            if ($approval->revoked_at !== null) {
                if ($approval->revoke_request_id !== $data['request_id']
                    || $approval->revoke_request_hash !== $hash) {
                    $this->conflict('requirement_equivalence_revoked');
                }

                return response()->json(['approval' => $this->record($approval), 'replayed' => true])
                    ->header('Cache-Control', 'private, no-store');
            }
            if ((int) $approval->revision !== (int) $data['revision']) {
                $this->conflict('requirement_equivalence_changed');
            }
            $actor = $request->user();
            $now = now();
            $db->table('study_group_requirement_equivalences')->where('id', $approvalId)->update([
                'revision' => $approval->revision + 1, 'revoked_by' => $actor->id,
                'revoked_by_name' => $actor->name, 'revoke_reason' => $data['reason'],
                'revoked_at' => $now, 'revoke_request_id' => $data['request_id'],
                'revoke_request_hash' => $hash,
            ]);
            $approval = $db->table('study_group_requirement_equivalences')->where('id', $approvalId)->first();
            $this->audit($actor->id, [$groups[$groupId]->branch_id,
                $groups[$context->candidate_group_id]->branch_id],
                'study_group.requirement_equivalence_revoked', [
                    'id' => $approvalId, 'required_group_id' => $groupId,
                    'candidate_group_id' => $context->candidate_group_id,
                    'required_requirement_id' => $approval->required_requirement_id,
                    'candidate_requirement_id' => $approval->candidate_requirement_id,
                    'reason' => $data['reason'], 'request_id' => $data['request_id'],
                ]);

            return response()->json(['approval' => $this->record($approval)])
                ->header('Cache-Control', 'private, no-store');
        });
    }

    private function group(string $groupId, CenterPermissions $permissions, bool $lock = false,
        ?string $requiredRequirementId = null): object
    {
        $query = DB::connection('tenant')->table('study_groups as groups')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->where('groups.id', $groupId)
            ->select(['groups.id', 'groups.level_id', 'groups.revision', 'courses.branch_id']);
        if ($requiredRequirementId !== null) {
            $query->selectRaw(<<<'SQL'
(SELECT row_to_json(required) FROM (
    SELECT id, number, content, title FROM study_group_requirements
    WHERE id = ? AND group_id = groups.id AND plan_lecture_id IS NULL AND retired_at IS NULL
) AS required) AS required_requirement
SQL, [$requiredRequirementId]);
        }
        if ($lock) {
            $query->lockForUpdate();
        }
        $group = $query->first();
        abort_unless($group && $permissions->can('read', (int) $group->branch_id), 404);

        return $group;
    }

    private function record(object $approval): array
    {
        return ['id' => $approval->id,
            'required_requirement_id' => $approval->required_requirement_id,
            'candidate_requirement_id' => $approval->candidate_requirement_id,
            'required_group_id' => $approval->required_group_id,
            'candidate_group_id' => $approval->candidate_group_id,
            'reason' => $approval->reason, 'approved_at' => $approval->approved_at,
            'revision' => (int) $approval->revision, 'revoked_at' => $approval->revoked_at ?? null];
    }

    private function audit(int $actorId, array $branches, string $event, array $details): void
    {
        foreach (array_unique(array_map('intval', $branches)) as $branchId) {
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $actorId, 'branch_id' => $branchId,
                'event' => $event, 'details' => json_encode($details), 'created_at' => now(),
            ]);
        }
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
