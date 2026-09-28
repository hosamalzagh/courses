<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\StudentPhotos;
use App\Support\StudyWaitlistEntry;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudyWaitlistController extends Controller
{
    public function options(Request $request, string $studentId, string $attemptId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($attemptId), 404);
        $data = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'history_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'q' => ['sometimes', 'string', 'max:100'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        $attempt = StudentPhotos::visibleStudent($studentId, $permissions, 'enrollment.manage')
            ->join('study_attempts as attempts', 'attempts.student_id', '=', 'students.id')
            ->join('student_branches as association', function ($join): void {
                $join->on('association.student_id', '=', 'students.id')
                    ->on('association.branch_id', '=', 'attempts.branch_id');
            })
            ->where('attempts.id', $attemptId)
            ->first(['attempts.id', 'attempts.level_id', 'attempts.plan_version_id',
                'attempts.branch_id', 'attempts.status', 'attempts.current_group_id', 'attempts.revision']);
        abort_unless($attempt && $permissions->can('enrollment.manage', (int) $attempt->branch_id), 404);
        $page = (int) ($data['page'] ?? 1);
        $historyPage = (int) ($data['history_page'] ?? 1);
        $readableBranches = array_keys(array_filter($permissions->branchRoles,
            fn (array $roles): bool => in_array('read', CenterPermissions::actions($roles), true)));
        $history = DB::connection('tenant')->table('study_attempt_waitlists')->where('attempt_id', $attemptId)
            ->when(! $permissions->isCenterManager(), fn ($query) => $query->whereIn('branch_id', $readableBranches))
            ->orderByDesc('entered_on')->orderByDesc('created_at')->orderByDesc('id')
            ->offset(($historyPage - 1) * 20)->limit(21)->get();
        $groups = collect();
        if ($attempt->status === 'active' && $attempt->current_group_id === null) {
            $search = trim($data['q'] ?? '');
            $groups = DB::connection('tenant')->table('study_groups as groups')
                ->join('levels', 'levels.id', '=', 'groups.level_id')
                ->join('stages', 'stages.id', '=', 'levels.stage_id')
                ->join('courses', 'courses.id', '=', 'stages.course_id')
                ->where('groups.level_id', $attempt->level_id)
                ->where('groups.plan_version_id', $attempt->plan_version_id)
                ->where('courses.branch_id', $attempt->branch_id)
                ->where('groups.status', '!=', 'completed')
                ->when($search !== '', fn ($query) => $query->where('groups.name', 'ILIKE', '%'.addcslashes($search, '%_\\').'%'))
                ->orderBy('groups.created_at')->orderBy('groups.id')
                ->offset(($page - 1) * 50)->limit(51)
                ->get(['groups.id', 'groups.name', 'groups.revision']);
        }

        return response()->json([
            'attempt_revision' => (int) $attempt->revision,
            'groups' => $groups->take(50)->values(),
            'history' => $history->take(20)->map(fn (object $row) => $this->present($row))->values(),
            'pagination' => ['page' => $page, 'has_more' => $groups->count() > 50,
                'history_page' => $historyPage, 'history_has_more' => $history->count() > 20],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function enter(Request $request, string $studentId, string $attemptId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($attemptId), 404);
        $data = $request->validate([
            'entered_on' => ['required', 'date_format:Y-m-d', 'before_or_equal:'.now('Africa/Cairo')->toDateString()],
            'reason' => ['required', 'string', 'max:2000'],
            'revision' => ['required', 'integer', 'min:1'],
            'request_id' => ['required', 'uuid'],
        ]);
        $data['reason'] = trim($data['reason']);
        abort_if($data['reason'] === '', 422, 'أدخل سبب الانتظار.');

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $attemptId, $data): JsonResponse {
            [$row, $created] = StudyWaitlistEntry::enter(
                $studentId, $attemptId, $data['entered_on'], $data['reason'],
                (int) $data['revision'], $data['request_id'],
                $request->user()->id, $request->user()->name, $permissions,
            );

            return response()->json(['waitlist' => $this->present($row)], $created ? 201 : 200);
        })->header('Cache-Control', 'private, no-store');
    }

    public function leave(Request $request, string $studentId, string $attemptId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($attemptId), 404);
        $data = $request->validate([
            'group_id' => ['required', 'uuid'],
            'group_revision' => ['required', 'integer', 'min:1'],
            'joined_on' => ['required', 'date_format:Y-m-d', 'before_or_equal:'.now('Africa/Cairo')->toDateString()],
            'revision' => ['required', 'integer', 'min:1'],
            'request_id' => ['required', 'uuid'],
        ]);
        $hash = hash('sha256', json_encode([$studentId, $attemptId, $data['group_id'],
            (int) $data['group_revision'], $data['joined_on']]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $attemptId, $data, $hash): JsonResponse {
            $student = StudentPhotos::visibleStudent($studentId, $permissions, 'enrollment.manage')
                ->lockForUpdate()->first(['students.id', 'students.status']);
            abort_unless($student, 404);
            $attempt = $this->attempt($studentId, $attemptId, $permissions);
            abort_unless(DB::connection('tenant')->table('student_branches')->where('student_id', $studentId)
                ->where('branch_id', $attempt->branch_id)->exists(), 404);
            $previous = DB::connection('tenant')->table('study_attempt_waitlists')
                ->where('exit_request_id', $data['request_id'])->first();
            if ($previous !== null) {
                abort_unless($previous->attempt_id === $attemptId && (int) $previous->left_by === $request->user()->id, 403);
                if ($previous->exit_request_hash !== $hash) {
                    $this->conflict('reattach_request_changed');
                }

                return response()->json(['waitlist' => $this->present($previous)]);
            }
            if ($student->status !== 'active' || $attempt->status !== 'active' || $attempt->current_group_id !== null
                || (int) $attempt->revision !== (int) $data['revision']) {
                $this->conflict('attempt_changed');
            }
            $waitlist = DB::connection('tenant')->table('study_attempt_waitlists')
                ->where('attempt_id', $attemptId)->whereNull('left_on')->lockForUpdate()->first();
            if ($waitlist === null) {
                $this->conflict('attempt_changed');
            }
            $group = DB::connection('tenant')->table('study_groups as groups')
                ->join('levels', 'levels.id', '=', 'groups.level_id')
                ->join('stages', 'stages.id', '=', 'levels.stage_id')
                ->join('courses', 'courses.id', '=', 'stages.course_id')
                ->where('groups.id', $data['group_id'])->lockForUpdate()
                ->first(['groups.id', 'groups.level_id', 'groups.plan_version_id', 'groups.status',
                    'groups.revision', 'courses.branch_id']);
            abort_unless($group && $permissions->can('enrollment.manage', (int) $group->branch_id), 404);
            abort_unless($group->branch_id === $attempt->branch_id && $group->level_id === $attempt->level_id
                && $group->plan_version_id === $attempt->plan_version_id, 422,
                'اختر مجموعة في الفرع والمستوى وإصدار الخطة نفسها.');
            abort_unless(DB::connection('tenant')->table('student_branches')->where('student_id', $studentId)
                ->where('branch_id', $group->branch_id)->exists(), 404);
            if ($group->status === 'completed' || (int) $group->revision !== (int) $data['group_revision']) {
                $this->conflict('group_changed');
            }
            abort_if($data['joined_on'] < $waitlist->entered_on, 422, 'تاريخ الإلحاق يسبق بداية الانتظار.');
            $latestPeriodEnd = DB::connection('tenant')->table('study_attempt_group_periods')
                ->where('attempt_id', $attemptId)->max('left_on');
            abort_if($latestPeriodEnd === null || $data['joined_on'] < $latestPeriodEnd, 409, 'تغير تاريخ ارتباط المجموعة.');
            abort_if(DB::connection('tenant')->table('study_attempt_group_periods')
                ->where('attempt_id', $attemptId)->whereNull('left_on')->exists(), 409, 'توجد مجموعة نشطة بالفعل.');
            $now = now();
            DB::connection('tenant')->table('study_attempt_group_periods')->insert([
                'id' => (string) Str::uuid(), 'attempt_id' => $attemptId,
                'group_id' => $group->id, 'joined_on' => $data['joined_on'], 'created_at' => $now,
            ]);
            DB::connection('tenant')->table('study_attempts')->where('id', $attemptId)->update([
                'current_group_id' => $group->id, 'revision' => $attempt->revision + 1, 'updated_at' => $now,
            ]);
            DB::connection('tenant')->table('study_attempt_waitlists')->where('id', $waitlist->id)->update([
                'to_group_id' => $group->id, 'left_on' => $data['joined_on'],
                'left_by' => $request->user()->id, 'left_by_name' => $request->user()->name,
                'exit_request_id' => $data['request_id'], 'exit_request_hash' => $hash, 'updated_at' => $now,
            ]);
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'branch_id' => $attempt->branch_id,
                'event' => 'student.study_reattached',
                'details' => json_encode(['student_id' => $studentId, 'attempt_id' => $attemptId,
                    'from_group_id' => $waitlist->from_group_id, 'to_group_id' => $group->id,
                    'waitlisted_on' => $waitlist->entered_on, 'joined_on' => $data['joined_on'],
                    'reason' => $waitlist->reason]), 'created_at' => $now,
            ]);

            return response()->json(['waitlist' => $this->present(DB::connection('tenant')->table('study_attempt_waitlists')
                ->where('id', $waitlist->id)->firstOrFail())], 201);
        })->header('Cache-Control', 'private, no-store');
    }

    private function attempt(string $studentId, string $attemptId, CenterPermissions $permissions): object
    {
        $attempt = DB::connection('tenant')->table('study_attempts')->where('id', $attemptId)
            ->where('student_id', $studentId)->lockForUpdate()->first();
        abort_unless($attempt && $permissions->can('enrollment.manage', (int) $attempt->branch_id), 404);

        return $attempt;
    }

    private function present(object $row): array
    {
        return ['id' => $row->id, 'attempt_id' => $row->attempt_id,
            'from_group_id' => $row->from_group_id, 'to_group_id' => $row->to_group_id,
            'entered_on' => $row->entered_on, 'left_on' => $row->left_on,
            'reason' => $row->reason, 'entered_by_name' => $row->entered_by_name,
            'left_by_name' => $row->left_by_name];
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
