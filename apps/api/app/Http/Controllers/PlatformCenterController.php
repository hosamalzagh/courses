<?php

namespace App\Http\Controllers;

use App\Jobs\ProvisionCenter;
use App\Models\Center;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

class PlatformCenterController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $this->platformMember($request);

        $centers = Center::query()
            ->when($request->string('search')->isNotEmpty(), fn ($query) => $query->where(function ($query) use ($request): void {
                $term = '%'.$request->string('search').'%';
                $query->where('name', 'ilike', $term)->orWhere('slug', 'ilike', $term);
            }))
            ->with('domains:id,tenant_id,domain')
            ->orderBy('name')
            ->paginate(20);

        return response()->json($centers);
    }

    public function store(Request $request): JsonResponse
    {
        $this->platformOwner($request);

        $data = $request->validate([
            'name' => ['required', 'string', 'max:255'],
            'slug' => ['required', 'regex:/^[a-z][a-z0-9-]{1,62}$/', 'unique:tenants,slug'],
            'subdomain' => ['required', 'regex:/^[a-z][a-z0-9-]{1,62}$/', Rule::notIn(['platform', 'www', 'api'])],
            'plan' => ['required', 'string', 'max:80'],
            'owner_email' => ['required', 'email', 'max:255'],
        ]);

        $domain = $data['subdomain'].'.'.config('courses.base_domain');
        validator(['domain' => $domain], ['domain' => 'unique:domains,domain'])->validate();

        $center = DB::connection('central')->transaction(function () use ($data, $domain, $request): Center {
            $center = Center::create([
                'name' => $data['name'],
                'slug' => $data['slug'],
                'plan' => $data['plan'],
                'owner_email' => strtolower($data['owner_email']),
            ]);
            $center->domains()->create(['domain' => $domain]);

            $this->audit($request, $center, 'center.created', ['domain' => $domain]);

            return $center;
        });

        ProvisionCenter::dispatch($center->id);

        return response()->json(['center' => $center->fresh()->load('domains')], 201);
    }

    public function show(Request $request, Center $center): JsonResponse
    {
        $this->platformMember($request);

        return response()->json(['center' => $center->load('domains')]);
    }

    public function retry(Request $request, Center $center): JsonResponse
    {
        $this->platformOwner($request);

        abort_unless($center->provisioning_status === 'failed', 409);

        ProvisionCenter::dispatch($center->id);
        $this->audit($request, $center, 'center.provisioning_retried');

        return response()->json(['center' => $center->fresh()->load('domains')]);
    }

    public function update(Request $request, Center $center): JsonResponse
    {
        $this->platformOwner($request);

        $data = $request->validate([
            'name' => ['sometimes', 'required', 'string', 'max:255'],
            'plan' => ['sometimes', 'required', 'string', 'max:80'],
            'suspended' => ['sometimes', 'required', 'boolean'],
        ]);

        $center->update($data);
        $this->audit($request, $center, 'center.updated', $data);

        return response()->json(['center' => $center->fresh()->load('domains')]);
    }

    public function changeDomain(Request $request, Center $center): JsonResponse
    {
        $this->platformOwner($request);

        $data = $request->validate([
            'subdomain' => ['required', 'regex:/^[a-z][a-z0-9-]{1,62}$/', Rule::notIn(['platform', 'www', 'api'])],
        ]);
        $domain = $data['subdomain'].'.'.config('courses.base_domain');
        validator(['domain' => $domain], ['domain' => 'unique:domains,domain'])->validate();

        DB::connection('central')->transaction(function () use ($center, $domain): void {
            $center->domains()->delete();
            $center->domains()->create(['domain' => $domain]);
        });
        $this->audit($request, $center, 'center.domain_changed', ['domain' => $domain]);

        return response()->json(['center' => $center->fresh()->load('domains')]);
    }

    private function platformMember(Request $request): void
    {
        abort_unless(in_array($request->user()?->platform_role, ['platform_owner', 'platform_support'], true), 403);
    }

    private function platformOwner(Request $request): void
    {
        abort_unless($request->user()?->platform_role === 'platform_owner', 403);
    }

    private function audit(Request $request, Center $center, string $event, array $details = []): void
    {
        DB::connection('central')->table('platform_audit_logs')->insert([
            'actor_id' => $request->user()->id,
            'tenant_id' => $center->id,
            'event' => $event,
            'details' => json_encode($details),
            'created_at' => now(),
        ]);
    }
}
