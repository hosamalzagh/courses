<?php

namespace Tests\Feature;

use Tests\TestCase;

class ExampleTest extends TestCase
{
    public function test_platform_root_redirects_to_landlord(): void
    {
        $response = $this->get('http://courses.test/');

        $response->assertRedirect('/admin');
    }
}
