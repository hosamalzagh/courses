<?php

namespace App\Support;

class StudentAccountVersion
{
    public static function forActor(string $studentId, int $revision, int $actorId): string
    {
        return hash_hmac('sha256', $studentId.':'.$revision.':'.$actorId, config('app.key'));
    }
}
