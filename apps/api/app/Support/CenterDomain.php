<?php

namespace App\Support;

use Illuminate\Validation\Rule;

class CenterDomain
{
    public static function subdomainRules(): array
    {
        return ['required', 'regex:/^[a-z][a-z0-9-]{1,62}$/', Rule::notIn(['platform', 'www', 'api'])];
    }

    public static function fromSubdomain(string $subdomain, string $field = 'subdomain'): string
    {
        validator([$field => $subdomain], [$field => self::subdomainRules()])->validate();

        return $subdomain.'.'.config('courses.base_domain');
    }

    public static function validateUnique(string $domain, ?string $currentDomain = null): void
    {
        if ($domain !== $currentDomain) {
            validator(['domain' => $domain], ['domain' => 'unique:domains,domain'])->validate();
        }
    }
}
