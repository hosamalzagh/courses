<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\StudentPhotos;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudentFinancialNoteController extends Controller
{
    public function payment(Request $request, string $studentId, string $eventId): JsonResponse
    {
        return $this->show($request, $studentId, $eventId, 'payment');
    }

    public function allocation(Request $request, string $studentId, string $eventId): JsonResponse
    {
        return $this->show($request, $studentId, $eventId, 'allocation');
    }

    public function savePayment(Request $request, string $studentId, string $eventId): JsonResponse
    {
        return $this->save($request, $studentId, $eventId, 'payment');
    }

    public function saveAllocation(Request $request, string $studentId, string $eventId): JsonResponse
    {
        return $this->save($request, $studentId, $eventId, 'allocation');
    }

    private function show(Request $request, string $studentId, string $eventId, string $type): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($eventId), 404);
        $data = $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $permissions = $request->attributes->get('center_permissions');
        $event = $this->event($studentId, $eventId, $type, $permissions, false, true);
        $this->authorize($permissions, $event, $type);
        $note = $event->note_id === null ? null : (object) [
            'id' => $event->note_id, 'student_id' => $event->note_student_id,
            'branch_id' => $event->note_branch_id, 'body' => $event->note_body,
            'important' => $event->note_important, 'revision' => $event->note_revision,
            'created_by_name' => $event->note_created_by_name, 'updated_by_name' => $event->note_updated_by_name,
            'created_at' => $event->note_created_at, 'updated_at' => $event->note_updated_at,
        ];
        abort_unless($note === null || ($note->student_id === $studentId && (int) $note->branch_id === (int) $event->branch_id), 409);
        $page = (int) ($data['page'] ?? 1);
        $versions = $note === null ? collect() : DB::connection('tenant')->table('student_event_note_revisions')
            ->where('note_id', $note->id)->orderByDesc('revision')->offset(($page - 1) * 20)->limit(21)
            ->get(['revision', 'body', 'important', 'actor_name', 'created_at']);

        return response()->json([
            'note' => $note === null ? null : $this->present($note),
            'can_edit' => $this->canEdit($request->attributes->get('center_permissions'), $event, $type),
            'versions' => $versions->take(20)->values(),
            'pagination' => ['page' => $page, 'has_more' => $versions->count() > 20],
        ])->header('Cache-Control', 'private, no-store');
    }

    private function save(Request $request, string $studentId, string $eventId, string $type): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($eventId), 404);
        $request->merge(['body' => is_string($request->input('body')) ? trim($request->input('body')) : $request->input('body')]);
        $data = $request->validate([
            'body' => ['required', 'string', 'max:2000'],
            'important' => ['required', 'boolean'],
            'revision' => ['required', 'integer', 'min:0'],
            'request_id' => ['required', 'uuid'],
        ]);
        $data['important'] = (bool) $data['important'];
        $hash = hash('sha256', json_encode([$studentId, $type, $eventId, $data['body'], $data['important'], (int) $data['revision']]));

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $eventId, $type, $data, $hash): JsonResponse {
            $db = DB::connection('tenant');
            $event = $this->event($studentId, $eventId, $type, $permissions, true);
            $this->authorize($permissions, $event, $type);
            abort_unless($this->canEdit($permissions, $event, $type), 403);
            $note = $db->table('student_event_notes')->where('event_type', $type)->where('event_id', $eventId)
                ->lockForUpdate()->first();
            abort_unless($note === null || ($note->student_id === $studentId && (int) $note->branch_id === (int) $event->branch_id), 409);
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
                    'id' => $noteId, 'student_id' => $studentId, 'branch_id' => $event->branch_id,
                    'event_type' => $type, 'event_id' => $eventId, 'body' => $data['body'],
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
                'actor_id' => $actor->id, 'branch_id' => $event->branch_id,
                'event' => $note === null ? "student.{$type}_note_created" : "student.{$type}_note_updated",
                'details' => json_encode(['student_id' => $studentId, 'event_type' => $type, 'event_id' => $eventId,
                    'note_id' => $noteId, 'revision' => $newRevision, 'important' => $data['important']]),
                'created_at' => $now,
            ]);

            return response()->json(['note' => $this->present($db->table('student_event_notes')->where('id', $noteId)->first())],
                $note === null ? 201 : 200)->header('Cache-Control', 'private, no-store');
        });
    }

    private function event(string $studentId, string $eventId, string $type, CenterPermissions $permissions, bool $lock = false, bool $withNote = false): object
    {
        $students = StudentPhotos::visibleStudent($studentId, $permissions, 'finance.read');
        $query = $type === 'payment'
            ? $students->join('student_payments as events', 'events.student_id', '=', 'students.id')
                ->where('events.id', $eventId)->select(['events.branch_id'])
            : $students->join('student_payment_allocations as events', 'events.student_id', '=', 'students.id')
                ->where('events.id', $eventId)->select(['events.source_branch_id as branch_id', 'events.target_branch_id']);
        if ($withNote) {
            $query->leftJoin('student_event_notes as notes', function ($join) use ($type): void {
                $join->on('notes.event_id', '=', 'events.id')->where('notes.event_type', $type);
            })->addSelect(['notes.id as note_id', 'notes.student_id as note_student_id',
                'notes.branch_id as note_branch_id', 'notes.body as note_body', 'notes.important as note_important',
                'notes.revision as note_revision', 'notes.created_by_name as note_created_by_name',
                'notes.updated_by_name as note_updated_by_name', 'notes.created_at as note_created_at',
                'notes.updated_at as note_updated_at']);
        }
        $event = $lock ? $query->lockForUpdate()->first() : $query->first();
        abort_unless($event, 404);

        return $event;
    }

    private function authorize(CenterPermissions $permissions, object $event, string $type): void
    {
        abort_unless($permissions->can('finance.read', (int) $event->branch_id)
            && ($type !== 'allocation' || $permissions->can('finance.read', (int) $event->target_branch_id)), 404);
    }

    private function canEdit(CenterPermissions $permissions, object $event, string $type): bool
    {
        return $permissions->can($type === 'payment' ? 'payments.record' : 'payments.allocate', (int) $event->branch_id);
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
