<?php

namespace App\Support;

use Illuminate\Database\Query\Builder;
use stdClass;

class StudentAttachments
{
    public static function visibleStudent(string $id, CenterPermissions $permissions, string $action): Builder
    {
        return StudentPhotos::visibleStudent($id, $permissions, $action);
    }

    public static function payload(stdClass $row): array
    {
        return [
            'id' => $row->id,
            'title' => $row->title,
            'classification' => $row->classification,
            'mime' => $row->mime,
            'size_bytes' => (int) $row->size_bytes,
            'created_at' => $row->created_at,
            'preview_url' => '/api/v1/center/students/'.$row->student_id.'/attachments/'.$row->id.'/preview',
            'download_url' => '/api/v1/center/students/'.$row->student_id.'/attachments/'.$row->id.'/download',
        ];
    }
}
