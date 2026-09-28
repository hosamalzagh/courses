<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudentEventNoteController extends Controller
{
    public function show(Request $request, string $studentId, string $attemptId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($attemptId), 404);
        $data = $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $permissions = $request->attributes->get('center_permissions');
        $row = DB::connection('tenant')->table('study_attempts as attempts')
            ->leftJoin('student_event_notes as notes', function ($join): void {
                $join->on('notes.event_id', '=', 'attempts.id')->where('notes.event_type', 'study_attempt');
            })
            ->where('attempts.id', $attemptId)->where('attempts.student_id', $studentId)
            ->first(['attempts.branch_id', 'notes.id', 'notes.body', 'notes.important', 'notes.revision',
                'notes.created_by_name', 'notes.updated_by_name', 'notes.created_at', 'notes.updated_at']);
        abort_unless($row && $permissions->can('read', (int) $row->branch_id), 404);
        $page = (int) ($data['page'] ?? 1);
        $versions = $row->id === null ? collect() : DB::connection('tenant')->table('student_event_note_revisions')
            ->where('note_id', $row->id)->orderByDesc('revision')->offset(($page - 1) * 20)->limit(21)
            ->get(['revision', 'body', 'important', 'actor_name', 'created_at']);

        return response()->json([
            'note' => $row->id === null ? null : $this->present($row),
            'versions' => $versions->take(20)->values(),
            'pagination' => ['page' => $page, 'has_more' => $versions->count() > 20],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function save(Request $request, string $studentId, string $attemptId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($attemptId), 404);
        $request->merge(['body' => is_string($request->input('body')) ? trim($request->input('body')) : $request->input('body')]);
        $data = $request->validate([
            'body' => ['required', 'string', 'max:2000'],
            'important' => ['required', 'boolean'],
            'revision' => ['required', 'integer', 'min:0'],
            'request_id' => ['required', 'uuid'],
        ]);
        $data['important'] = (bool) $data['important'];
        $hash = hash('sha256', json_encode([$studentId, $attemptId, $data['body'], $data['important'], (int) $data['revision']]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $attemptId, $data, $hash): JsonResponse {
            $db = DB::connection('tenant');
            $attempt = $db->table('study_attempts')->where('id', $attemptId)->where('student_id', $studentId)
                ->lockForUpdate()->first(['id', 'branch_id']);
            abort_unless($attempt && $permissions->can('enrollment.manage', (int) $attempt->branch_id), 404);
            $note = $db->table('student_event_notes')->where('event_type', 'study_attempt')->where('event_id', $attemptId)
                ->lockForUpdate()->first();
            $previous = $db->table('student_event_note_revisions')->where('request_id', $data['request_id'])->first();
            if ($previous !== null) {
                abort_unless($note && $previous->note_id === $note->id && $previous->actor_id === $request->user()->id, 403);
                if (! hash_equals($previous->request_hash, $hash)) {
                    $this->conflict('note_request_changed');
                }

                return response()->json(['note' => $this->present($note)])->header('Cache-Control', 'private, no-store');
            }
            if ((int) ($note?->revision ?? 0) !== (int) $data['revision']) {
                $this->conflict('note_changed');
            }
            $now = now();
            $actor = $request->user();
            $newRevision = (int) $data['revision'] + 1;
            if ($note === null) {
                $noteId = (string) Str::uuid();
                $db->table('student_event_notes')->insert([
                    'id' => $noteId, 'student_id' => $studentId, 'branch_id' => $attempt->branch_id,
                    'event_type' => 'study_attempt', 'event_id' => $attemptId, 'body' => $data['body'],
                    'important' => $data['important'], 'revision' => $newRevision,
                    'created_by' => $actor->id, 'created_by_name' => $actor->name,
                    'updated_by' => $actor->id, 'updated_by_name' => $actor->name,
                    'created_at' => $now, 'updated_at' => $now,
                ]);
            } else {
                $noteId = $note->id;
                $db->table('student_event_notes')->where('id', $noteId)->update([
                    'body' => $data['body'], 'important' => $data['important'], 'revision' => $newRevision,
                    'updated_by' => $actor->id, 'updated_by_name' => $actor->name, 'updated_at' => $now,
                ]);
            }
            $db->table('student_event_note_revisions')->insert([
                'id' => (string) Str::uuid(), 'note_id' => $noteId, 'revision' => $newRevision,
                'body' => $data['body'], 'important' => $data['important'], 'actor_id' => $actor->id,
                'actor_name' => $actor->name, 'request_id' => $data['request_id'], 'request_hash' => $hash,
                'created_at' => $now,
            ]);
            $db->table('center_audit_logs')->insert([
                'actor_id' => $actor->id, 'branch_id' => $attempt->branch_id,
                'event' => $note === null ? 'student.study_attempt_note_created' : 'student.study_attempt_note_updated',
                'details' => json_encode(['student_id' => $studentId, 'attempt_id' => $attemptId,
                    'note_id' => $noteId, 'revision' => $newRevision, 'important' => $data['important']]),
                'created_at' => $now,
            ]);

            return response()->json(['note' => $this->present($db->table('student_event_notes')->where('id', $noteId)->first())],
                $note === null ? 201 : 200)->header('Cache-Control', 'private, no-store');
        });
    }

    private function present(object $row): array
    {
        return ['id' => $row->id, 'body' => $row->body, 'important' => (bool) $row->important,
            'revision' => (int) $row->revision, 'created_by_name' => $row->created_by_name,
            'updated_by_name' => $row->updated_by_name, 'created_at' => $row->created_at,
            'updated_at' => $row->updated_at];
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
