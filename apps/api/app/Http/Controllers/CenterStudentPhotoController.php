<?php

namespace App\Http\Controllers;

use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\StudentPhotos;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Validation\Rules\File;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Throwable;

class CenterStudentPhotoController extends Controller
{
    public function store(Request $request, string $studentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId), 404);
        abort_unless(StudentPhotos::visibleStudent($studentId, $request->attributes->get('center_permissions'), 'students.manage')->exists(), 404);
        $data = $request->validate([
            'photo' => ['required', File::image()->types(['jpg', 'jpeg', 'png', 'webp'])->max(10 * 1024)],
            'request_id' => ['required', 'uuid'], 'photo_revision' => ['required', 'integer', 'min:1'],
            'attachment_id' => ['prohibited'], 'path' => ['prohibited'], 'classification' => ['prohibited'],
        ], ['photo.*' => 'اختر صورة JPEG أو PNG أو WebP صحيحة لا تتجاوز 10 MB.']);
        $file = $request->file('photo');
        $hash = hash('sha256', json_encode([$studentId, (int) $data['photo_revision'], hash_file('sha256', $file->getRealPath())]));
        $storedPath = null;
        try {
            return CenterWrites::run($request, function (CenterPermissions $permissions) use ($request, $studentId, $data, $file, $hash, &$storedPath): JsonResponse {
                $db = DB::connection('tenant');
                $student = StudentPhotos::visibleStudent($studentId, $permissions, 'students.manage')->lockForUpdate()->first();
                abort_unless($student, 404);
                $existing = $db->table('student_photos')->where('id', $data['request_id'])->first();
                if ($existing) {
                    abort_unless($existing->actor_id === $request->user()->id, 403);
                    $this->requireCurrent($existing->request_hash === $hash && $student->photo_id === $existing->id && $student->photo_revision === $existing->photo_revision);

                    return response()->json(['photo' => StudentPhotos::payload($existing), 'photo_revision' => $student->photo_revision]);
                }
                $this->requireCurrent($student->photo_revision === (int) $data['photo_revision']);
                $preview = StudentPhotos::preview($file);
                $path = 'student-photos/'.$request->attributes->get('center')->id.'/'.$data['request_id'];
                abort_unless(Storage::disk('local')->put($path, $file->getContent()), 503, 'تعذر حفظ الصورة؛ الصورة الحالية وبيانات الملف محفوظة.');
                $storedPath = $path;
                $photo = ['id' => $data['request_id'], 'student_id' => $studentId, 'request_hash' => $hash,
                    'photo_revision' => $student->photo_revision + 1, 'path' => $path, 'mime' => $file->getMimeType(),
                    'preview' => $preview, 'actor_id' => $request->user()->id, 'created_at' => now()];
                $db->table('student_photos')->insert($photo);
                $db->table('students')->where('id', $studentId)->update(['photo_id' => $photo['id'], 'photo_revision' => $photo['photo_revision'], 'updated_at' => now()]);
                foreach ($db->table('student_branches')->where('student_id', $studentId)->pluck('branch_id') as $branchId) {
                    $db->table('center_audit_logs')->insert(['actor_id' => $request->user()->id, 'branch_id' => $branchId, 'event' => 'student.photo_changed',
                        'details' => json_encode(['student_id' => $studentId, 'before' => $student->photo_id, 'after' => $photo['id']]), 'created_at' => now()]);
                }

                return response()->json(['photo' => StudentPhotos::payload((object) $photo), 'photo_revision' => $photo['photo_revision']], 201);
            })->header('Cache-Control', 'private, no-store');
        } catch (Throwable $exception) {
            if ($storedPath !== null) {
                try {
                    if (! DB::connection('tenant')->table('student_photos')->where('id', $data['request_id'])->exists()) {
                        Storage::disk('local')->delete($storedPath);
                    }
                } catch (Throwable $cleanupFailure) {
                    report($cleanupFailure);
                }
            }
            throw $exception;
        }
    }

    public function show(Request $request, string $studentId, string $photoId): BinaryFileResponse
    {
        abort_unless(Str::isUuid($studentId) && Str::isUuid($photoId), 404);
        $student = StudentPhotos::visibleStudent($studentId, $request->attributes->get('center_permissions'), 'read')
            ->where('photo_id', $photoId)->join('student_photos', 'student_photos.id', '=', 'students.photo_id')->first(['path', 'mime']);
        abort_unless($student && Storage::disk('local')->exists($student->path), 404);

        return response()->file(Storage::disk('local')->path($student->path), ['Content-Type' => $student->mime,
            'Cache-Control' => 'private, no-store', 'X-Content-Type-Options' => 'nosniff'])->setPrivate();
    }

    private function requireCurrent(bool $valid): void
    {
        if (! $valid) {
            throw new HttpResponseException(response()->json(['code' => 'student_photo_changed'], 409));
        }
    }
}
