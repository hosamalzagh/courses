<?php

namespace App\Support;

class StudyCoverageCredits
{
    /**
     * @param  array<int, array{id: string, final: bool}>  $attendance
     * @param  array<int, array{id: string, source_lecture_ids: array, target_lecture_ids: array}>  $approvals
     * @return array{lectures: array<string, bool>, dependencies: array<string, array<int, string>>}
     */
    public static function resolve(array $attendance, array $approvals): array
    {
        $credited = [];
        $dependencies = [];
        foreach ($attendance as $entry) {
            $id = $entry['id'];
            if (! array_key_exists($id, $credited) || ($entry['final'] && ! $credited[$id])) {
                $credited[$id] = (bool) $entry['final'];
                $dependencies[$id] = [];
            }
        }
        do {
            $changed = false;
            foreach ($approvals as $approval) {
                $sources = $approval['source_lecture_ids'];
                if ($sources === [] || count(array_diff($sources, array_keys($credited))) > 0) {
                    continue;
                }
                $final = collect($sources)->every(fn (string $id): bool => $credited[$id]);
                $sourceDependencies = [$approval['id']];
                foreach ($sources as $id) {
                    array_push($sourceDependencies, ...$dependencies[$id]);
                }
                $sourceDependencies = array_values(array_unique($sourceDependencies));
                foreach ($approval['target_lecture_ids'] as $id) {
                    if (! array_key_exists($id, $credited) || ($final && ! $credited[$id])) {
                        $credited[$id] = $final;
                        $dependencies[$id] = $sourceDependencies;
                        $changed = true;
                    }
                }
            }
        } while ($changed);

        return ['lectures' => $credited, 'dependencies' => $dependencies];
    }
}
