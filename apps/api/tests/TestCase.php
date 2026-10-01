<?php

namespace Tests;

use Illuminate\Foundation\Testing\TestCase as BaseTestCase;

abstract class TestCase extends BaseTestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        // Real Redis rate-limit buckets must not leak between unrelated tests.
        $address = '2001:db8::'.implode(':', str_split(bin2hex(random_bytes(8)), 4));
        $this->withServerVariables(['REMOTE_ADDR' => $address]);
    }
}
