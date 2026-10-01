<?php

namespace App\Support;

use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

/** A session-bound, immutable selection. Raw permissions remain independent. */
class CenterWorkspace
{
    public function __construct(
        public ?string $id,
        public string $mode,
        public ?array $branch = null,
    ) {}

    public static function entry(Request $request): ?array
    {
        // The picker must remain reachable after a selection is revoked.
        if ($request->is('api/v1/center/workspaces')) {
            return null;
        }
        $id = $request->header('X-Courses-Workspace');
        if ($id === null) {
            $id = $request->session()->get('initial_workspace');
        }
        if ($id === null) {
            if ($request->session()->get('workspace_required')) {
                self::unavailable('workspace_required');
            }

            return null;
        }
        $entry = $request->session()->get('center_workspaces', [])[$id] ?? null;
        if (! $entry || $entry['user_id'] !== $request->user()?->id || $entry['center_id'] !== $request->attributes->get('center')?->id) {
            self::unavailable('workspace_expired');
        }

        return ['id' => $id, ...$entry];
    }

    public static function resolve(?array $entry, CenterPermissions $permissions, ?array $branch): ?self
    {
        if ($entry === null) {
            return $permissions->isCenterManager() ? new self(null, 'center') : null;
        }
        if ($entry['mode'] === 'center') {
            if (! $permissions->isCenterManager()) {
                self::unavailable('workspace_expired');
            }

            return new self($entry['id'], 'center');
        }
        if (! $branch || ! $permissions->can('read', $entry['branch_id'])) {
            self::unavailable('workspace_expired');
        }

        return new self($entry['id'], 'branch', $branch);
    }

    public static function select(Request $request, string $mode, ?array $branch): self
    {
        $id = (string) Str::uuid();
        $entries = $request->session()->get('center_workspaces', []);
        $entries[$id] = ['mode' => $mode, 'branch_id' => $branch['id'] ?? null,
            'user_id' => $request->user()->id, 'center_id' => $request->attributes->get('center')->id];
        // Bound session size; an evicted old tab returns to the picker safely.
        $request->session()->put('center_workspaces', array_slice($entries, -128, null, true));
        $request->session()->put('workspace_required', true);
        if (! $request->session()->has('initial_workspace')) {
            $request->session()->put('initial_workspace', $id);
        }

        return new self($id, $mode, $branch);
    }

    public function constrain(Builder $query, string $column): void
    {
        if ($this->mode === 'branch') {
            $query->where($column, $this->branch['id']);
        }
    }

    public function assertBranch(int $branchId): void
    {
        abort_if($this->mode === 'branch' && $this->branch['id'] !== $branchId, 403);
    }

    public function toArray(): array
    {
        return ['id' => $this->id, 'mode' => $this->mode, 'branch' => $this->branch];
    }

    public static function section(string $returnTo): string
    {
        $path = parse_url($returnTo, PHP_URL_PATH);
        // Only known internal section roots; never retain another branch's IDs.
        if (! is_string($path) || ! preg_match('#^/admin(?:/(students|instructors|curriculum|equivalences|groups|absence-review|members|audit|settings))(?:/|$)#', $path, $match)) {
            return '/admin';
        }

        return '/admin/'.$match[1];
    }

    public function destination(string $returnTo = '/admin'): string
    {
        return self::section($returnTo).'?workspace='.$this->id;
    }

    private static function unavailable(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
