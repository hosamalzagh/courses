<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\StudentAttachments;
use App\Support\StudentIdentity;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\Rules\File;
use stdClass;
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
                        'current_version' => 1, 'content_classification' => $item['classification'],
                        'archived_at' => null, 'archived_by' => null,
                    ];
                    $db->table('student_attachments')->insert($row);
                    $db->table('student_attachment_versions')->insert([
                        'id' => (string) Str::uuid(), 'attachment_id' => $id, 'version' => 1,
                        'classification' => $item['classification'], 'mime' => $row['mime'],
                        'size_bytes' => $row['size_bytes'], 'path' => $path,
                        'actor_id' => $request->user()->id, 'actor_name' => $request->user()->name, 'created_at' => $row['created_at'],
                    ]);
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

    public function versions(Request $request, string $studentId, string $attachmentId): JsonResponse
    {
        $page = $request->validate(['page' => ['sometimes', 'integer', 'min:1', 'max:100000']]);
        $permissions = $request->attributes->get('center_permissions');
        $attachment = $this->readableAttachment($studentId, $attachmentId, $permissions);
        $rows = DB::connection('tenant')->table('student_attachment_versions')
            ->where('attachment_id', $attachmentId)
            ->when(! $attachment->identity_access, fn (Builder $query) => $query->where('classification', 'general'))
            ->orderByDesc('version')->offset(((int) ($page['page'] ?? 1) - 1) * 20)->limit(21)
            ->get(['id', 'version', 'classification', 'mime', 'size_bytes', 'actor_id', 'actor_name', 'created_at']);

        return response()->json([
            'attachment' => StudentAttachments::payload($attachment),
            'versions' => $rows->take(20)->map(fn (stdClass $row): array => [
                'id' => $row->id, 'version' => $row->version, 'classification' => $row->classification,
                'mime' => $row->mime, 'size_bytes' => $row->size_bytes, 'actor_id' => $row->actor_id,
                'actor_name' => $row->actor_name,
                'created_at' => $row->created_at,
                'preview_url' => $this->versionUrl($studentId, $attachmentId, $row->id, 'preview'),
                'download_url' => $this->versionUrl($studentId, $attachmentId, $row->id, 'download'),
            ])->values(),
            'pagination' => ['page' => (int) ($page['page'] ?? 1), 'has_more' => $rows->count() > 20],
            'attachment_revision' => $attachment->attachment_revision,
        ])->header('Cache-Control', 'private, no-store');
    }

    public function previewVersion(Request $request, string $studentId, string $attachmentId, string $versionId): BinaryFileResponse
    {
        return $this->serveVersion($request, $studentId, $attachmentId, $versionId, false);
    }

    public function downloadVersion(Request $request, string $studentId, string $attachmentId, string $versionId): BinaryFileResponse
    {
        return $this->serveVersion($request, $studentId, $attachmentId, $versionId, true);
    }

    public function replace(Request $request, string $studentId, string $attachmentId): JsonResponse
    {
        $data = $request->validate([
            'request_id' => ['required', 'uuid'], 'attachment_revision' => ['required', 'integer', 'min:1'],
            'title' => ['sometimes', 'required', 'string', 'max:120'],
            'file' => ['required', File::types(['jpg', 'jpeg', 'png', 'webp', 'pdf'])->max(10 * 1024)],
        ]);
        $sha = hash_file('sha256', $data['file']->getRealPath());
        $hash = hash('sha256', json_encode([$studentId, $attachmentId, trim($data['title'] ?? ''), $sha], JSON_UNESCAPED_UNICODE));
        $path = null;
        try {
            return $this->write($request, $studentId, $attachmentId, $data, 'replace', $hash, function ($db, $student, $attachment, $branches) use ($request, $data, $sha, &$path): array {
                abort_if($attachment->archived_at !== null, 409);
                $version = $attachment->current_version + 1;
                $versionId = (string) Str::uuid();
                $path = 'student-attachments/'.$request->attributes->get('center')->id.'/'.$versionId;
                $stream = fopen($data['file']->getRealPath(), 'rb');
                try {
                    abort_unless(Storage::disk('local')->put($path, $stream), 503, 'تعذر حفظ النسخة الجديدة.');
                } finally {
                    fclose($stream);
                }
                abort_unless(Storage::disk('local')->size($path) === $data['file']->getSize()
                    && hash_file('sha256', Storage::disk('local')->path($path)) === $sha, 503, 'تعذر إكمال حفظ النسخة الجديدة.');
                $db->table('student_attachment_versions')->insert([
                    'id' => $versionId, 'attachment_id' => $attachment->id, 'version' => $version,
                    'classification' => $attachment->classification, 'mime' => $data['file']->getMimeType(),
                    'size_bytes' => $data['file']->getSize(), 'path' => $path,
                    'actor_id' => $request->user()->id, 'actor_name' => $request->user()->name, 'created_at' => now(),
                ]);
                $db->table('student_attachments')->where('id', $attachment->id)->update([
                    'current_version' => $version, 'content_classification' => $attachment->classification,
                    'path' => $path, 'mime' => $data['file']->getMimeType(), 'size_bytes' => $data['file']->getSize(),
                    'title' => trim($data['title'] ?? $attachment->title),
                ]);

                return ['from_version' => $attachment->current_version, 'to_version' => $version];
            });
        } catch (Throwable $exception) {
            if ($path !== null) {
                try {
                    if (! DB::connection('tenant')->table('student_attachment_versions')->where('path', $path)->exists()) {
                        Storage::disk('local')->delete($path);
                    }
                } catch (Throwable $cleanupFailure) {
                    report($cleanupFailure);
                }
            }
            throw $exception;
        }
    }

    public function classify(Request $request, string $studentId, string $attachmentId): JsonResponse
    {
        $data = $request->validate([
            'request_id' => ['required', 'uuid'], 'attachment_revision' => ['required', 'integer', 'min:1'],
            'classification' => ['required', 'in:general,identity'],
        ]);
        $hash = hash('sha256', json_encode([$studentId, $attachmentId, $data['classification']]));

        return $this->write($request, $studentId, $attachmentId, $data, 'classify', $hash, function ($db, $student, $attachment, $branches, $permissions) use ($request, $data): array {
            abort_if($attachment->archived_at !== null, 409);
            abort_if($attachment->classification === $data['classification'], 409);
            if ($data['classification'] === 'identity' || $attachment->classification === 'identity') {
                abort_unless(StudentIdentity::canManage($permissions, $branches), 403);
            }
            $version = $attachment->current_version + 1;
            $db->table('student_attachment_versions')->insert([
                'id' => (string) Str::uuid(), 'attachment_id' => $attachment->id,
                'version' => $version, 'classification' => $data['classification'],
                'mime' => $attachment->mime, 'size_bytes' => $attachment->size_bytes,
                'path' => $attachment->path, 'actor_id' => $request->user()->id, 'actor_name' => $request->user()->name, 'created_at' => now(),
            ]);
            $db->table('student_attachments')->where('id', $attachment->id)->update([
                'classification' => $data['classification'], 'content_classification' => $data['classification'],
                'current_version' => $version,
            ]);

            return ['from_classification' => $attachment->classification, 'to_classification' => $data['classification'], 'from_version' => $attachment->current_version, 'to_version' => $version];
        });
    }

    public function archive(Request $request, string $studentId, string $attachmentId): JsonResponse
    {
        $data = $request->validate(['request_id' => ['required', 'uuid'], 'attachment_revision' => ['required', 'integer', 'min:1']]);
        $hash = hash('sha256', json_encode([$studentId, $attachmentId, 'archive']));

        return $this->write($request, $studentId, $attachmentId, $data, 'archive', $hash, function ($db, $student, $attachment) use ($request): array {
            abort_if($attachment->archived_at !== null, 409);
            $db->table('student_attachments')->where('id', $attachment->id)->update(['archived_at' => now(), 'archived_by' => $request->user()->id]);

            return ['from_status' => 'active', 'to_status' => 'archived', 'version' => $attachment->current_version];
        });
    }

    public function restore(Request $request, string $studentId, string $attachmentId): JsonResponse
    {
        $data = $request->validate(['request_id' => ['required', 'uuid'], 'attachment_revision' => ['required', 'integer', 'min:1']]);
        $hash = hash('sha256', json_encode([$studentId, $attachmentId, 'restore']));

        return $this->write($request, $studentId, $attachmentId, $data, 'restore', $hash, function ($db, $student, $attachment): array {
            abort_if($attachment->archived_at === null, 409);
            $db->table('student_attachments')->where('id', $attachment->id)->update(['archived_at' => null, 'archived_by' => null]);

            return ['from_status' => 'archived', 'to_status' => 'active', 'version' => $attachment->current_version];
        }, restore: true);
    }

    private function write(Request $request, string $studentId, string $attachmentId, array $data, string $kind, string $hash, callable $change, bool $restore = false): JsonResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($attachmentId), 404);

        return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $attachmentId, $data, $kind, $hash, $change, $restore): JsonResponse {
            abort_if($restore && ! $permissions->isCenterManager(), 403);
            $db = DB::connection('tenant');
            $student = StudentAttachments::visibleStudent($studentId, $permissions, $restore ? 'read' : 'students.manage')->lockForUpdate()->first();
            abort_unless($student, 404);
            $attachment = $db->table('student_attachments')->where('student_id', $studentId)->where('id', $attachmentId)->lockForUpdate()->first();
            abort_unless($attachment, 404);
            $branches = $db->table('student_branches')->where('student_id', $studentId)->pluck('branch_id')->all();
            if ($attachment->classification === 'identity' || $attachment->content_classification === 'identity') {
                abort_unless(StudentIdentity::canManage($permissions, $branches), 403);
            }
            $existing = $db->table('student_attachment_operations')->where('request_id', $data['request_id'])->first();
            if ($existing !== null) {
                abort_unless($existing->attachment_id === $attachmentId && $existing->actor_id === $request->user()->id, 403);
                $this->requireCurrent($existing->kind === $kind && $existing->request_hash === $hash);

                return response()->json(['attachment' => StudentAttachments::payload($attachment), 'attachment_revision' => $student->attachment_revision])->header('Cache-Control', 'private, no-store');
            }
            $this->requireCurrent($student->attachment_revision === (int) $data['attachment_revision']);
            $changes = $change($db, $student, $attachment, $branches, $permissions);
            $db->table('student_attachment_operations')->insert([
                'request_id' => $data['request_id'], 'attachment_id' => $attachmentId,
                'kind' => $kind, 'request_hash' => $hash, 'actor_id' => $request->user()->id, 'created_at' => now(),
            ]);
            $db->table('students')->where('id', $studentId)->update(['attachment_revision' => $student->attachment_revision + 1, 'updated_at' => now()]);
            foreach ($branches as $branchId) {
                $db->table('center_audit_logs')->insert([
                    'actor_id' => $request->user()->id, 'branch_id' => $branchId,
                    'event' => 'student.attachment_'.$kind,
                    'details' => json_encode(['student_id' => $studentId, 'attachment_id' => $attachmentId, ...$changes], JSON_UNESCAPED_UNICODE),
                    'created_at' => now(),
                ]);
            }
            $current = $db->table('student_attachments')->where('id', $attachmentId)->first();

            return response()->json(['attachment' => StudentAttachments::payload($current), 'attachment_revision' => $student->attachment_revision + 1])->header('Cache-Control', 'private, no-store');
        });
    }

    private function readableAttachment(string $studentId, string $attachmentId, CenterPermissions $permissions): stdClass
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($attachmentId), 404);
        $query = StudentAttachments::visibleStudent($studentId, $permissions, 'read')
            ->join('student_attachments', 'student_attachments.student_id', '=', 'students.id')
            ->where('student_attachments.id', $attachmentId)
            ->select(['student_attachments.*', 'students.attachment_revision']);
        if (! $permissions->isCenterManager()) {
            $identity = DB::connection('tenant')->table('student_branches')
                ->whereColumn('student_branches.student_id', 'students.id')
                ->whereIn('student_branches.branch_id', StudentIdentity::readableBranches($permissions))
                ->selectRaw('1')->limit(1);
            $query->selectSub($identity, 'identity_access');
        }
        $row = $query->first();
        abort_unless($row && ($row->archived_at === null || $permissions->isCenterManager()), 404);
        $row->identity_access = $permissions->isCenterManager() || (bool) ($row->identity_access ?? false);
        if ($row->classification === 'identity' || $row->content_classification === 'identity') {
            abort_unless($row->identity_access, 404);
        }

        return $row;
    }

    private function serveVersion(Request $request, string $studentId, string $attachmentId, string $versionId, bool $download): BinaryFileResponse
    {
        abort_unless(Str::isUuid($versionId), 404);
        $permissions = $request->attributes->get('center_permissions');
        $attachment = $this->readableAttachment($studentId, $attachmentId, $permissions);
        $version = DB::connection('tenant')->table('student_attachment_versions')->where('attachment_id', $attachmentId)->where('id', $versionId)->first();
        abort_unless($version, 404);
        if ($version->classification === 'identity') {
            abort_unless($attachment->identity_access, 404);
        }

        return $this->fileResponse($version->path, $version->mime, $attachment->title, $download);
    }

    private function versionUrl(string $studentId, string $attachmentId, string $versionId, string $action): string
    {
        return '/api/v1/center/students/'.$studentId.'/attachments/'.$attachmentId.'/versions/'.$versionId.'/'.$action;
    }

    private function serve(Request $request, string $studentId, string $attachmentId, bool $download): BinaryFileResponse
    {
        $row = $this->readableAttachment($studentId, $attachmentId, $request->attributes->get('center_permissions'));

        return $this->fileResponse($row->path, $row->mime, $row->title, $download);
    }

    private function fileResponse(string $path, string $mime, string $title, bool $download): BinaryFileResponse
    {
        abort_unless(Storage::disk('local')->exists($path), 404);
        $extension = match ($mime) {
            'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp', 'application/pdf' => 'pdf',
            default => abort(404),
        };
        $response = $download
            ? response()->download(Storage::disk('local')->path($path), $title.'.'.$extension)
            : response()->file(Storage::disk('local')->path($path), ['Content-Type' => $mime]);

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
