<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use DateInterval;
use DateTimeImmutable;
use DateTimeZone;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudySessionController extends Controller
{
    public function workspace(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $data = $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $permissions = $request->attributes->get('center_permissions');
        $group = $this->group($groupId, $permissions);
        $page = (int) ($data['page'] ?? 1);
        $rows = $this->sessions($groupId)->orderBy('sessions.scheduled_at')->orderBy('sessions.id')
            ->offset(($page - 1) * 20)->limit(21)->get();

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(),
            'group' => $group,
            'sessions' => $rows->take(20)->values(),
            'pagination' => ['page' => $page, 'has_more' => $rows->count() > 20],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function preview(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $data = $this->scheduleData($request);
        $permissions = $request->attributes->get('center_permissions');
        $group = $this->group($groupId, $permissions);
        abort_unless($permissions->can('curriculum.manage', $group['branch_id']), 403);
        if ($group['revision'] !== (int) $data['revision'] || $group['status'] === 'completed') {
            $this->conflict('group_changed');
        }

        return response()->json(['group_revision' => $group['revision'],
            'sessions' => $this->prepare($groupId, $group['plan_version_id'], $data),
        ])->header('Cache-Control', 'private, no-store');
    }

    public function store(Request $request, string $groupId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId), 404);
        $data = $this->scheduleData($request);
        $requestId = $request->validate(['request_id' => ['required', 'uuid']])['request_id'];
        $hash = hash('sha256', json_encode([$groupId, $data]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $groupId, $data, $requestId, $hash): JsonResponse {
            $group = $this->group($groupId, $permissions, true);
            abort_unless($permissions->can('curriculum.manage', $group['branch_id']), 403);
            $existing = DB::connection('tenant')->table('study_session_submissions')->where('request_id', $requestId)->first();
            if ($existing) {
                abort_unless($existing->group_id === $groupId && $existing->actor_id === $request->user()->id, 403);
                if ($existing->request_hash !== $hash) $this->conflict('session_request_changed');

                return response()->json(['sessions' => $this->sessions($groupId)->whereIn('sessions.id', json_decode($existing->session_ids, true))->get(),
                    'group_revision' => $group['revision']])
                    ->header('Cache-Control', 'private, no-store');
            }
            if ($group['revision'] !== (int) $data['revision'] || $group['status'] === 'completed') {
                $this->conflict('group_changed');
            }
            $prepared = $this->prepare($groupId, $group['plan_version_id'], $data);
            $now = now();
            $actor = $request->user();
            $ids = [];
            foreach ($prepared as $session) {
                $id = (string) Str::uuid();
                $ids[] = $id;
                DB::connection('tenant')->table('study_sessions')->insert([
                    'id' => $id, 'group_id' => $groupId, 'plan_lecture_id' => $session['plan_lecture_id'],
                    'number' => $session['number'], 'title' => $session['title'], 'scheduled_at' => $session['scheduled_at'],
                    'status' => 'planned', 'revision' => 1, 'created_by' => $actor->id, 'created_by_name' => $actor->name,
                    'created_at' => $now, 'updated_at' => $now,
                ]);
            }
            DB::connection('tenant')->table('study_groups')->where('id', $groupId)->update([
                'revision' => $group['revision'] + 1, 'updated_at' => $now,
            ]);
            DB::connection('tenant')->table('study_session_submissions')->insert([
                'request_id' => $requestId, 'group_id' => $groupId, 'kind' => $data['kind'],
                'request_hash' => $hash, 'actor_id' => $actor->id, 'session_ids' => json_encode($ids), 'created_at' => $now,
            ]);
            $this->audit($actor->id, $group['branch_id'], 'study_sessions.scheduled', [
                'group_id' => $groupId, 'session_ids' => $ids, 'sessions' => $prepared,
            ]);

            return response()->json(['sessions' => $this->sessions($groupId)->whereIn('sessions.id', $ids)->get(),
                'group_revision' => $group['revision'] + 1], 201)->header('Cache-Control', 'private, no-store');
        });
    }

    public function postpone(Request $request, string $groupId, string $sessionId): JsonResponse
    {
        abort_unless(Str::isUuid($groupId) && Str::isUuid($sessionId), 404);
        $data = $request->validate([
            'revision' => ['required', 'integer', 'min:1'],
            'scheduled_at' => ['required', 'date_format:Y-m-d\\TH:i'],
            'reason' => ['nullable', 'string', 'max:1000'],
            'request_id' => ['required', 'uuid'],
        ]);
        $newTime = $this->time($data['scheduled_at']);
        $hash = hash('sha256', json_encode([$groupId, $sessionId, $data]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $groupId, $sessionId, $data, $newTime, $hash): JsonResponse {
            $group = $this->group($groupId, $permissions, true);
            abort_unless($permissions->can('curriculum.manage', $group['branch_id']), 403);
            $existing = DB::connection('tenant')->table('study_session_submissions')->where('request_id', $data['request_id'])->first();
            if ($existing) {
                abort_unless($existing->group_id === $groupId && $existing->actor_id === $request->user()->id, 403);
                if ($existing->request_hash !== $hash) $this->conflict('session_request_changed');

                return response()->json(['session' => $this->sessions($groupId)->where('sessions.id', $sessionId)->firstOrFail(),
                    'group_revision' => $group['revision']])
                    ->header('Cache-Control', 'private, no-store');
            }
            $session = DB::connection('tenant')->table('study_sessions')->where('id', $sessionId)->where('group_id', $groupId)
                ->lockForUpdate()->first();
            abort_unless($session, 404);
            if ($group['status'] === 'completed' || $session->status !== 'planned'
                || (int) $session->revision !== (int) $data['revision']) $this->conflict('session_changed');
            $oldTime = new DateTimeImmutable($session->scheduled_at);
            if ($oldTime <= new DateTimeImmutable('now') || $newTime <= $oldTime) $this->conflict('session_not_future');
            if (DB::connection('tenant')->table('study_sessions')->where('group_id', $groupId)
                ->where('id', '!=', $sessionId)->where('status', '!=', 'cancelled')->where('scheduled_at', $newTime->format('Y-m-d H:i:sP'))->exists()) {
                $this->conflict('session_time_taken');
            }
            $now = now();
            DB::connection('tenant')->table('study_sessions')->where('id', $sessionId)->update([
                'scheduled_at' => $newTime->format('Y-m-d H:i:sP'), 'revision' => $session->revision + 1, 'updated_at' => $now,
            ]);
            DB::connection('tenant')->table('study_groups')->where('id', $groupId)->update([
                'revision' => $group['revision'] + 1, 'updated_at' => $now,
            ]);
            DB::connection('tenant')->table('study_session_submissions')->insert([
                'request_id' => $data['request_id'], 'group_id' => $groupId, 'kind' => 'postpone',
                'request_hash' => $hash, 'actor_id' => $request->user()->id, 'session_ids' => json_encode([$sessionId]),
                'created_at' => $now,
            ]);
            $this->audit($request->user()->id, $group['branch_id'], 'study_session.postponed', [
                'group_id' => $groupId, 'session_id' => $sessionId,
                'before' => $oldTime->format(DATE_ATOM), 'after' => $newTime->format(DATE_ATOM),
                'reason' => trim($data['reason'] ?? '') ?: null,
            ]);

            return response()->json(['session' => $this->sessions($groupId)->where('sessions.id', $sessionId)->firstOrFail(),
                'group_revision' => $group['revision'] + 1])->header('Cache-Control', 'private, no-store');
        });
    }

    private function scheduleData(Request $request): array
    {
        $data = $request->validate([
            'kind' => ['required', 'in:single,weekly'],
            'revision' => ['required', 'integer', 'min:1'],
            'start_at' => ['required', 'date_format:Y-m-d\\TH:i'],
            'count' => ['required_if:kind,weekly', 'integer', 'min:1', 'max:20'],
            'interval_weeks' => ['required_if:kind,weekly', 'integer', 'min:1', 'max:4'],
            'plan_lecture_number' => ['required_if:kind,single', 'integer', 'min:1'],
            'title' => ['nullable', 'string', 'max:255'],
        ]);
        $data['title'] = trim($data['title'] ?? '') ?: null;
        if ($data['kind'] === 'single') {
            $data['count'] = 1;
            $data['interval_weeks'] = 1;
        } else {
            $data['plan_lecture_number'] = null;
            $data['title'] = null;
        }
        $this->time($data['start_at']);

        return $data;
    }

    private function prepare(string $groupId, string $planVersionId, array $data): array
    {
        $db = DB::connection('tenant');
        $requirements = $db->table('plan_lectures')->where('plan_version_id', $planVersionId)
            ->orderBy('number')->get(['id', 'number', 'title']);
        $existing = $db->table('study_sessions')->where('group_id', $groupId)->where('status', '!=', 'cancelled')
            ->get(['plan_lecture_id', 'scheduled_at']);
        $occupied = $existing->pluck('plan_lecture_id')->all();
        $available = $requirements->reject(fn ($lecture) => in_array($lecture->id, $occupied, true))->values();
        if ($data['kind'] === 'single') {
            $selected = $available->firstWhere('number', (int) $data['plan_lecture_number']);
            abort_unless($selected, 422, 'اختر محاضرة خطة غير مجدولة لهذا الإصدار.');
            $selectedLectures = collect([$selected]);
        } else {
            $selectedLectures = $available->take((int) $data['count']);
            abort_unless($selectedLectures->count() === (int) $data['count'], 422, 'عدد المواعيد يتجاوز محاضرات الخطة غير المجدولة.');
        }
        $number = (int) $db->table('study_sessions')->where('group_id', $groupId)->max('number');
        $time = $this->time($data['start_at']);
        $result = [];
        foreach ($selectedLectures as $lecture) {
            $utc = $time->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:sP');
            abort_if($existing->contains(fn ($row) => (new DateTimeImmutable($row->scheduled_at))->getTimestamp() === $time->getTimestamp()),
                422, 'يوجد موعد آخر للمجموعة في الوقت المحدد.');
            $result[] = ['number' => ++$number, 'plan_lecture_id' => $lecture->id,
                'plan_lecture_number' => (int) $lecture->number,
                'title' => $data['kind'] === 'single' ? $data['title'] : $lecture->title,
                'scheduled_at' => $utc, 'local_at' => $time->format('Y-m-d\TH:i')];
            $time = $time->add(new DateInterval('P'.(7 * (int) $data['interval_weeks']).'D'));
        }

        return $result;
    }

    private function group(string $groupId, CenterPermissions $permissions, bool $lock = false): array
    {
        $query = DB::connection('tenant')->table('study_groups as groups')
            ->join('levels', 'levels.id', '=', 'groups.level_id')
            ->join('stages', 'stages.id', '=', 'levels.stage_id')
            ->join('courses', 'courses.id', '=', 'stages.course_id')
            ->where('groups.id', $groupId)
            ->select(['groups.id', 'groups.name', 'groups.status', 'groups.revision', 'groups.plan_version_id',
                'courses.branch_id', 'levels.name as level_name'])
            ->selectRaw("COALESCE((SELECT json_agg(json_build_object('number', number, 'title', title, 'content', content) ORDER BY number) FROM (SELECT number, title, content FROM plan_lectures WHERE plan_version_id = groups.plan_version_id ORDER BY number LIMIT 200) AS plan), '[]'::json) AS requirements");
        $query->selectRaw("COALESCE((SELECT json_agg(lecture_number ORDER BY lecture_number) FROM (SELECT DISTINCT lectures.number AS lecture_number FROM study_sessions AS sessions JOIN plan_lectures AS lectures ON lectures.id = sessions.plan_lecture_id WHERE sessions.group_id = groups.id AND sessions.status <> 'cancelled' ORDER BY lecture_number LIMIT 200) AS scheduled), '[]'::json) AS scheduled_requirements");
        if ($lock) $query->lockForUpdate();
        $row = $query->first();
        abort_unless($row && $permissions->can('read', (int) $row->branch_id), 404);

        return [...(array) $row, 'revision' => (int) $row->revision, 'branch_id' => (int) $row->branch_id,
            'requirements' => json_decode($row->requirements, true),
            'scheduled_requirements' => json_decode($row->scheduled_requirements, true),
            'can_manage' => $permissions->can('curriculum.manage', (int) $row->branch_id)];
    }

    private function sessions(string $groupId): Builder
    {
        return DB::connection('tenant')->table('study_sessions as sessions')
            ->join('plan_lectures as lectures', 'lectures.id', '=', 'sessions.plan_lecture_id')
            ->where('sessions.group_id', $groupId)
            ->select(['sessions.id', 'sessions.number', 'sessions.title', 'sessions.scheduled_at',
                'sessions.status', 'sessions.revision', 'lectures.number as plan_lecture_number', 'lectures.content']);
    }

    private function time(string $input): DateTimeImmutable
    {
        $time = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', $input, new DateTimeZone('Africa/Cairo'));
        abort_unless($time && $time->format('Y-m-d\TH:i') === $input && $time > new DateTimeImmutable('now'),
            422, 'أدخل موعدًا مستقبليًا صحيحًا بتوقيت القاهرة.');

        return $time;
    }

    private function audit(int $actorId, int $branchId, string $event, array $details): void
    {
        DB::connection('tenant')->table('center_audit_logs')->insert([
            'actor_id' => $actorId, 'branch_id' => $branchId, 'event' => $event,
            'details' => json_encode($details), 'created_at' => now(),
        ]);
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
