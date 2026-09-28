<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\StudentAttachments;
use App\Support\StudentIdentity;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\Rules\File;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Throwable;

class CenterStudentAttachmentController extends Controller
{
    public function store(Request $request, string $studentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId), 404);
        abort_unless(StudentAttachments::visibleStudent($studentId, $request->attributes->get('center_permissions'), 'students.manage')->exists(), 404);
        $data = $request->validate([
            'request_id' => ['required', 'uuid'],
            'attachment_revision' => ['required', 'integer', 'min:1'],
            'attachments' => ['required', 'array', 'min:1', 'max:5'],
            'attachments.*.title' => ['required', 'string', 'max:120'],
            'attachments.*.classification' => ['required', 'in:general,identity'],
            'attachments.*.file' => ['required', File::types(['jpg', 'jpeg', 'png', 'webp', 'pdf'])->max(10 * 1024)],
        ], ['attachments.*.file.*' => 'اختر صورة JPEG أو PNG أو WebP أو PDF صحيحًا لا يتجاوز 10 MB.']);

        $items = collect($data['attachments'])->values()->map(fn (array $item): array => [
            'title' => trim($item['title']),
            'classification' => $item['classification'],
            'file' => $item['file'],
            'sha256' => hash_file('sha256', $item['file']->getRealPath()),
        ])->all();
        $hash = hash('sha256', json_encode([$studentId, array_map(fn (array $item): array => [$item['title'], $item['classification'], $item['sha256']], $items)], JSON_UNESCAPED_UNICODE));
        $storedPaths = [];
        try {
            return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $data, $items, $hash, &$storedPaths): JsonResponse {
                $db = DB::connection('tenant');
                $student = StudentAttachments::visibleStudent($studentId, $permissions, 'students.manage')->lockForUpdate()->first();
                abort_unless($student, 404);
                $branches = $db->table('student_branches')->where('student_id', $studentId)->pluck('branch_id')->all();
                if (collect($items)->contains(fn (array $item): bool => $item['classification'] === 'identity')) {
                    abort_unless(StudentIdentity::canManage($permissions, $branches), 403);
                }
                $existing = $db->table('student_attachments')->where('request_id', $data['request_id'])->orderBy('position')->get();
                if ($existing->isNotEmpty()) {
                    abort_unless($existing->first()->student_id === $studentId && $existing->first()->actor_id === $request->user()->id, 403);
                    $this->requireCurrent($existing->count() === count($items) && $existing->first()->request_hash === $hash);

                    return response()->json(['attachments' => $existing->map(fn ($row): array => StudentAttachments::payload($row)), 'attachment_revision' => $student->attachment_revision]);
                }
                $this->requireCurrent($student->attachment_revision === (int) $data['attachment_revision']);
                $created = [];
                foreach ($items as $position => $item) {
                    $id = (string) Str::uuid();
                    $path = 'student-attachments/'.$request->attributes->get('center')->id.'/'.$id;
                    $storedPaths[] = $path;
                    $stream = fopen($item['file']->getRealPath(), 'rb');
                    try {
                        abort_unless(Storage::disk('local')->put($path, $stream), 503, 'تعذر حفظ المرفق؛ بيانات الملف محفوظة.');
                    } finally {
                        fclose($stream);
                    }
                    abort_unless(Storage::disk('local')->size($path) === $item['file']->getSize()
                        && hash_file('sha256', Storage::disk('local')->path($path)) === $item['sha256'], 503, 'تعذر إكمال حفظ المرفق؛ بيانات الملف محفوظة.');
                    $row = [
                        'id' => $id, 'student_id' => $studentId, 'request_id' => $data['request_id'],
                        'position' => $position, 'request_hash' => $hash,
                        'title' => $item['title'], 'classification' => $item['classification'],
                        'mime' => $item['file']->getMimeType(), 'size_bytes' => $item['file']->getSize(),
                        'path' => $path, 'actor_id' => $request->user()->id, 'created_at' => now(),
                    ];
                    $db->table('student_attachments')->insert($row);
                    $created[] = StudentAttachments::payload((object) $row);
                }
                $db->table('students')->where('id', $studentId)->update(['attachment_revision' => $student->attachment_revision + 1, 'updated_at' => now()]);
                foreach ($branches as $branchId) {
                    $db->table('center_audit_logs')->insert([
                        'actor_id' => $request->user()->id, 'branch_id' => $branchId,
                        'event' => 'student.attachments_added',
                        'details' => json_encode(['student_id' => $studentId, 'count' => count($created)]),
                        'created_at' => now(),
                    ]);
                }

                return response()->json(['attachments' => $created, 'attachment_revision' => $student->attachment_revision + 1], 201);
            })->header('Cache-Control', 'private, no-store');
        } catch (Throwable $exception) {
            foreach ($storedPaths as $path) {
                try {
                    if (! DB::connection('tenant')->table('student_attachments')->where('path', $path)->exists()) {
                        Storage::disk('local')->delete($path);
                    }
                } catch (Throwable $cleanupFailure) {
                    report($cleanupFailure);
                }
            }
            throw $exception;
        }
    }

    public function preview(Request $request, string $studentId, string $attachmentId): BinaryFileResponse
    {
        return $this->serve($request, $studentId, $attachmentId, false);
    }

    public function download(Request $request, string $studentId, string $attachmentId): BinaryFileResponse
    {
        return $this->serve($request, $studentId, $attachmentId, true);
    }

    private function serve(Request $request, string $studentId, string $attachmentId, bool $download): BinaryFileResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($attachmentId), 404);
        $permissions = $request->attributes->get('center_permissions');
        $query = StudentAttachments::visibleStudent($studentId, $permissions, 'read')
            ->join('student_attachments', 'student_attachments.student_id', '=', 'students.id')
            ->where('student_attachments.id', $attachmentId);
        if (! $permissions->isCenterManager()) {
            $query->where(function ($query) use ($permissions): void {
                $query->where('student_attachments.classification', 'general')
                    ->orWhereExists(DB::connection('tenant')->table('student_branches')
                        ->whereColumn('student_branches.student_id', 'students.id')
                        ->whereIn('student_branches.branch_id', StudentIdentity::readableBranches($permissions))->selectRaw('1'));
            });
        }
        $row = $query->first(['student_attachments.path', 'student_attachments.mime', 'student_attachments.title']);
        abort_unless($row && Storage::disk('local')->exists($row->path), 404);
        $extension = match ($row->mime) {
            'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp', 'application/pdf' => 'pdf',
            default => abort(404),
        };
        $response = $download
            ? response()->download(Storage::disk('local')->path($row->path), $row->title.'.'.$extension)
            : response()->file(Storage::disk('local')->path($row->path), ['Content-Type' => $row->mime]);

        $response->setPrivate();
        $response->headers->set('Cache-Control', 'private, no-store');
        $response->headers->set('X-Content-Type-Options', 'nosniff');
        $response->headers->set('Content-Security-Policy', "sandbox; default-src 'none'");

        return $response;
    }

    private function requireCurrent(bool $valid): void
    {
        if (! $valid) {
            throw new HttpResponseException(response()->json(['code' => 'student_attachments_changed'], 409));
        }
    }
}
