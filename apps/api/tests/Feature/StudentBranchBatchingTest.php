<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class StudentBranchBatchingTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    public function test_all_branch_creation_batches_writes_without_losing_associations_audit_or_manual_update_semantics(): void
    {
        Mail::fake();
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')
            ->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha',
                'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
            ])->assertCreated();
        $center = Center::where('slug', 'alpha')->firstOrFail();
        $owner = User::factory()->create(['email_verified_at' => now()]);
        CenterMembership::create(['tenant_id' => $center->id, 'user_id' => $owner->id, 'status' => 'active']);
        $center->run(fn () => DB::table('center_grants')->insert([
            'user_id' => $owner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
        ]));
        $base = 'http://alpha.courses.test/api/v1/center';
        $this->actingAs($owner, 'web')->withSession(['center_id' => $center->id]);
        $this->postJson("{$base}/workspaces", ['mode' => 'center'])->assertOk();
        $north = $this->postJson("{$base}/branches", ['name' => 'North', 'slug' => 'north'])->assertCreated()->json('branch.id');
        $south = $this->postJson("{$base}/branches", ['name' => 'South', 'slug' => 'south'])->assertCreated()->json('branch.id');
        $this->patchJson("{$base}/student-branch-settings", ['enabled' => true, 'revision' => 1])->assertOk();

        $small = $this->postJson("{$base}/students", [
            'name' => 'Small profile', 'branch_ids' => [$north], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->assertJsonPath('student.branch_ids', [$north, $south]);
        $smallCount = $small->headers->get('X-Courses-Query-Count');
        $this->assertNotNull($smallCount);
        $this->assertMatchesRegularExpression('/^\d+$/', $smallCount);

        $branches = $center->run(function (): array {
            $rows = [];
            for ($number = 1; $number <= 1000; $number++) {
                $rows[] = ['name' => "Batch {$number}", 'slug' => "batch-{$number}", 'created_at' => now(), 'updated_at' => now()];
            }
            DB::table('branches')->insert($rows);

            return DB::table('branches')->orderBy('id')->pluck('id')->all();
        });
        $this->assertCount(1002, $branches);
        $payload = ['name' => 'All branches profile', 'passport_number' => 'BATCH-001',
            'branch_ids' => [$north], 'request_id' => (string) Str::uuid()];
        $many = $this->postJson("{$base}/students", $payload)->assertCreated()
            ->assertJsonPath('student.branch_ids', $branches)->assertJsonPath('student.identity.passport_number', 'BATCH-001');
        $manyCount = $many->headers->get('X-Courses-Query-Count');
        $this->assertNotNull($manyCount);
        $this->assertMatchesRegularExpression('/^\d+$/', $manyCount);
        // Two additional 500-row chunks per table, rather than two writes per added branch.
        $this->assertLessThanOrEqual((int) $smallCount + 4, (int) $manyCount);
        $id = $many->json('student.id');
        $center->run(function () use ($id, $owner, $branches): void {
            $this->assertSame($branches, DB::table('student_branches')->where('student_id', $id)->orderBy('branch_id')->pluck('branch_id')->all());
            $audit = DB::table('center_audit_logs')->where('event', 'student.created')
                ->whereRaw("details->>'student_id' = ?", [$id])->orderBy('branch_id')->get();
            $this->assertSame($branches, $audit->pluck('branch_id')->all());
            $this->assertSame([$owner->id], $audit->pluck('actor_id')->unique()->values()->all());
            $details = $audit->map(fn ($row) => json_decode($row->details, true))->unique()->values();
            $this->assertCount(1, $details);
            $this->assertSame($id, $details[0]['student_id']);
            $this->assertNull($details[0]['before']);
            $this->assertSame('All branches profile', $details[0]['after']['name']);
            $this->assertSame(['passport_number'], $details[0]['identity_changed']);
            $this->assertSame([], $details[0]['custom_fields_changed']);
            $this->assertFalse($details[0]['associated_before']);
            $this->assertTrue($details[0]['associated_after']);
        });
        $this->postJson("{$base}/students", $payload)->assertOk()->assertJsonPath('student.id', $id);
        $center->run(function () use ($id): void {
            $this->assertSame(1002, DB::table('student_branches')->where('student_id', $id)->count());
            $this->assertSame(1002, DB::table('center_audit_logs')->where('event', 'student.created')->whereRaw("details->>'student_id' = ?", [$id])->count());
        });

        $added = $branches[array_key_last($branches)];
        $smallId = $small->json('student.id');
        $this->patchJson("{$base}/students/{$smallId}", [
            'name' => 'Manual update', 'branch_ids' => [$added], 'revision' => 1,
        ])->assertOk()->assertJsonPath('student.branch_ids', [$north, $south, $added]);
        $center->run(function () use ($smallId, $north, $south, $added): void {
            $this->assertSame([$north, $south, $added], DB::table('student_branches')->where('student_id', $smallId)->orderBy('branch_id')->pluck('branch_id')->all());
            $audit = DB::table('center_audit_logs')->where('event', 'student.updated')
                ->whereRaw("details->>'student_id' = ?", [$smallId])->orderBy('branch_id')->get();
            $this->assertSame([$north, $south, $added], $audit->pluck('branch_id')->all());
            $details = $audit->map(fn ($row) => json_decode($row->details, true));
            $this->assertSame([true, true, false], $details->pluck('associated_before')->all());
            $this->assertSame([true, true, true], $details->pluck('associated_after')->all());
            $this->assertSame(['Small profile'], $details->pluck('before.name')->unique()->values()->all());
            $this->assertSame(['Manual update'], $details->pluck('after.name')->unique()->values()->all());
        });
    }
}
