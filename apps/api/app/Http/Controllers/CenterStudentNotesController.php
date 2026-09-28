<?php

namespace App\Http\Controllers;

use App\Support\StudentEventNotes;
use App\Support\StudentPhotos;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class CenterStudentNotesController extends Controller
{
    public function index(Request $request, string $studentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId), 404);
        $data = $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $permissions = $request->attributes->get('center_permissions');
        abort_unless(StudentPhotos::visibleStudent($studentId, $permissions, 'read')->exists(), 404);
        $page = (int) ($data['page'] ?? 1);
        $rows = StudentEventNotes::visible($permissions)->where('notes.student_id', $studentId)
            ->orderByDesc('notes.updated_at')->orderByDesc('notes.id')
            ->offset(($page - 1) * 20)->limit(21)->get();

        return response()->json(['entries' => $rows->take(20)->values(),
            'pagination' => ['page' => $page, 'has_more' => $rows->count() > 20]])
            ->header('Cache-Control', 'private, no-store');
    }

    public function show(Request $request, string $studentId, string $noteId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($noteId), 404);
        $data = $request->validate(['before_revision' => ['sometimes', 'integer', 'min:1']]);
        $permissions = $request->attributes->get('center_permissions');
        abort_unless(StudentPhotos::visibleStudent($studentId, $permissions, 'read')->exists(), 404);
        $note = StudentEventNotes::visible($permissions)->where('notes.student_id', $studentId)
            ->where('notes.id', $noteId)->first();
        abort_unless($note, 404);
        $versions = DB::connection('tenant')->table('student_event_note_revisions')
            ->where('note_id', $noteId)
            ->when(isset($data['before_revision']), fn ($query) => $query->where('revision', '<', $data['before_revision']))
            ->orderByDesc('revision')->limit(21)
            ->get(['revision', 'body', 'important', 'actor_name', 'created_at']);
        $visible = $versions->take(20)->values();

        return response()->json(['note' => $note, 'versions' => $visible,
            'pagination' => ['has_more' => $versions->count() > 20,
                'next_before_revision' => $versions->count() > 20 ? $visible->last()->revision : null]])
            ->header('Cache-Control', 'private, no-store');
    }
}
