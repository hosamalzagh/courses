<?php

namespace App\Support;

use Illuminate\Support\Arr;
use Illuminate\Validation\Rule;

class CenterDomain
{
    public static function subdomainRules(): array
    {
        return ['required', 'regex:/^[a-z][a-z0-9-]{1,62}$/', Rule::notIn(['platform', 'www', 'api'])];
    }

    public static function fromSubdomain(string $subdomain, string $field = 'subdomain'): string
    {
        $input = [];
        Arr::set($input, $field, $subdomain);
        validator($input, [$field => self::subdomainRules()])->validate();

        return $subdomain.'.'.config('courses.base_domain');
    }

    public static function validateUnique(string $domain, ?string $currentDomain = null, string $field = 'domain'): void
    {
        if ($domain !== $currentDomain) {
            $input = [];
            Arr::set($input, $field, $domain);
            validator($input, [$field => 'unique:domains,domain'])->validate();
        }
    }
}
