<?php

namespace App\Support;

use Illuminate\Database\Query\Builder;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use stdClass;

class StudentPhotos
{
    public static function visibleStudent(string $id, CenterPermissions $permissions, string $action): Builder
    {
        return DB::connection('tenant')->table('students')->where('students.id', $id)
            ->when(! $permissions->isCenterManager(), function (Builder $query) use ($permissions, $action): void {
                $independent = $action === 'students.identity' || str_starts_with($action, 'payments.') || str_starts_with($action, 'finance.');
                $branches = array_values(array_filter(array_keys($permissions->branchRoles),
                    fn (int $branchId): bool => $independent ? $permissions->can($action, $branchId) : $permissions->canInWorkspace($action, $branchId)));
                $query->whereExists(DB::connection('tenant')->table('student_branches')->whereColumn('student_id', 'students.id')->whereIn('branch_id', $branches)->selectRaw('1'));
            })
            ->when($permissions->workspace?->mode === 'branch' && ! (str_starts_with($action, 'payments.') || str_starts_with($action, 'finance.')), function (Builder $query) use ($permissions): void {
                $query->whereExists(DB::connection('tenant')->table('student_branches')
                    ->whereColumn('student_id', 'students.id')->where('branch_id', $permissions->workspace->branch['id'])->selectRaw('1'));
            });
    }

    public static function summaryQuery(): Builder
    {
        return DB::connection('tenant')->table('student_photos')->whereColumn('student_photos.id', 'students.photo_id')
            ->selectRaw("json_build_object('id', student_photos.id, 'preview', preview, 'url', '/api/v1/center/students/' || student_id || '/photo/' || student_photos.id)");
    }

    public static function payload(stdClass $photo): array
    {
        return ['id' => $photo->id, 'preview' => $photo->preview, 'url' => '/api/v1/center/students/'.$photo->student_id.'/photo/'.$photo->id];
    }

    public static function preview(UploadedFile $file): string
    {
        $dimensions = @getimagesize($file->getRealPath());
        $available = (int) ini_parse_quantity(ini_get('memory_limit')) - memory_get_usage(true);
        if (! $dimensions || ($available > 0 && $available / 2 < $dimensions[0] * $dimensions[1] * 8)) {
            throw ValidationException::withMessages(['photo' => 'تعذر تجهيز الصورة. اختر صورة صحيحة بأبعاد أصغر.']);
        }
        $source = @imagecreatefromstring($file->getContent());
        if (! $source) {
            throw ValidationException::withMessages(['photo' => 'تعذر قراءة محتوى الصورة. اختر صورة صحيحة.']);
        }
        $ratio = min(1, 256 / max(imagesx($source), imagesy($source)));
        $thumbnail = imagecreatetruecolor(max(1, (int) round(imagesx($source) * $ratio)), max(1, (int) round(imagesy($source) * $ratio)));
        imagefill($thumbnail, 0, 0, imagecolorallocate($thumbnail, 255, 255, 255));
        imagecopyresampled($thumbnail, $source, 0, 0, 0, 0, imagesx($thumbnail), imagesy($thumbnail), imagesx($source), imagesy($source));
        ob_start();
        imagejpeg($thumbnail, null, 85);
        $bytes = ob_get_clean();

        return 'data:image/jpeg;base64,'.base64_encode($bytes);
    }
}
