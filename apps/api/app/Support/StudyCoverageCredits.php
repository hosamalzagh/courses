<?php

namespace App\Support;

class StudyCoverageCredits
{
    /**
     * @param  array<int, array{id: string, final: bool}>  $attendance
     * @param  array<int, array{id: string, source_lecture_ids: array, target_lecture_ids: array}>  $approvals
     * @return array{lectures: array<string, bool>, approval_ids: array<int, string>}
     */
    public static function resolve(array $attendance, array $approvals): array
    {
        $credited = [];
        foreach ($attendance as $entry) {
            $id = $entry['id'];
            $credited[$id] = ($credited[$id] ?? false) || (bool) $entry['final'];
        }
        $applied = [];
        do {
            $changed = false;
            foreach ($approvals as $approval) {
                $sources = $approval['source_lecture_ids'];
                if ($sources === [] || count(array_diff($sources, array_keys($credited))) > 0) {
                    continue;
                }
                $final = collect($sources)->every(fn (string $id): bool => $credited[$id]);
                $applied[$approval['id']] = true;
                foreach ($approval['target_lecture_ids'] as $id) {
                    if (! array_key_exists($id, $credited) || ($final && ! $credited[$id])) {
                        $credited[$id] = $final;
                        $changed = true;
                    }
                }
            }
        } while ($changed);

        return ['lectures' => $credited, 'approval_ids' => array_keys($applied)];
    }
}
