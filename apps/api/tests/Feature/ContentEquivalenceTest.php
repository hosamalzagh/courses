<?php

namespace Tests\Feature;

use App\Models\Center;
use App\Models\CenterMembership;
use App\Models\User;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Tests\Concerns\CleansCenterDatabases;
use Tests\TestCase;

class ContentEquivalenceTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    private Center $center;

    private User $owner;

    private User $staff;

    private int $north;

    private int $south;

    private string $base = 'http://alpha.courses.test/api/v1/center';

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')
            ->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => 'Alpha', 'slug' => 'alpha', 'subdomain' => 'alpha',
                'plan' => 'starter', 'owner_email' => 'owner@alpha.test',
            ])->assertCreated();
        $this->center = Center::where('slug', 'alpha')->firstOrFail();
        $this->owner = User::factory()->create();
        $this->staff = User::factory()->create();
        foreach ([$this->owner, $this->staff] as $user) {
            CenterMembership::create(['tenant_id' => $this->center->id, 'user_id' => $user->id, 'status' => 'active']);
        }
        $this->center->run(fn () => DB::table('center_grants')->insert([
            'user_id' => $this->owner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
        ]));
        $this->actingAs($this->owner, 'web')->withSession(['center_id' => $this->center->id]);
        $this->north = $this->postJson("{$this->base}/branches", ['name' => 'North', 'slug' => 'north'])->assertCreated()->json('branch.id');
        $this->south = $this->postJson("{$this->base}/branches", ['name' => 'South', 'slug' => 'south'])->assertCreated()->json('branch.id');
    }

    public function test_approval_requires_both_branches_and_preserves_whole_lecture_sets(): void
    {
        $source = $this->plan($this->north, 'Source', ['Letters', 'Words']);
        $target = $this->plan($this->south, 'Target', ['Alphabet', 'Reading']);
        $payload = $this->payload($source, $target);
        $path = "{$this->base}/content-equivalences";
        $this->grant([$this->north => ['academic_admin'], $this->south => ['branch_viewer']]);
        $this->asStaff();
        $this->postJson($path, $payload)->assertForbidden();
        $this->grant([$this->north => ['academic_admin']]);
        $this->asStaff();
        $this->postJson($path, $payload)->assertNotFound();
        $this->getJson($path)->assertOk()->assertJsonCount(1, 'options');
        $this->grant([$this->north => ['academic_admin'], $this->south => ['academic_admin']]);
        $this->asStaff();
        $saved = $this->postJson($path, $payload)->assertCreated()
            ->assertJsonPath('approval.reason', 'تمت مراجعة المحتوى الأكاديمي الكامل.')->json('approval');
        $this->assertSame([$source['plan']['lectures'][0]['id']], $saved['source_lecture_ids']);
        $this->assertEqualsCanonicalizing([$target['plan']['lectures'][0]['id'], $target['plan']['lectures'][1]['id']], $saved['target_lecture_ids']);
        $this->postJson($path, $payload)->assertOk()->assertJsonPath('approval.id', $saved['id'])
            ->assertJsonPath('replayed', true);
        $this->postJson($path, [...$payload, 'reason' => 'سبب مختلف تمامًا'])->assertConflict()
            ->assertJsonPath('code', 'equivalence_request_changed');
        $this->postJson($path, [...$payload, 'request_id' => (string) Str::uuid()])->assertConflict()
            ->assertJsonPath('code', 'equivalence_already_approved');
        $workspace = $this->getJson($path)->assertOk()->assertJsonPath('approvals.0.id', $saved['id']);
        $workspace->assertJsonPath('approvals.0.source_lectures.0.content', 'Letters')
            ->assertJsonPath('approvals.0.target_lectures.1.content', 'Reading');
        $this->assertLessThanOrEqual(6, (int) $workspace->headers->get('X-Courses-Query-Count'));
        $this->assertNotNull($workspace->headers->get('X-Courses-Query-Count'));
        $this->center->run(function () use ($saved, $source, $target): void {
            $this->assertSame(1, DB::table('content_equivalences')->count());
            $this->assertSame(2, DB::table('study_plan_versions')->whereIn('id', [$source['plan']['id'], $target['plan']['id']])
                ->whereNotNull('used_at')->count());
            try {
                DB::transaction(fn () => DB::table('plan_lectures')->where('id', $source['plan']['lectures'][0]['id'])
                    ->update(['content' => 'Changed after approval']));
                $this->fail('An approved source lecture must be immutable.');
            } catch (QueryException $exception) {
                $this->assertStringContainsString('Used study plan is immutable', $exception->getMessage());
            }
            try {
                DB::table('content_equivalences')->where('id', $saved['id'])->update(['reason' => 'Silent rewrite']);
                $this->fail('Approved equivalence must be immutable.');
            } catch (QueryException $exception) {
                $this->assertStringContainsString('Approved content equivalence is immutable', $exception->getMessage());
            }
            $logs = DB::table('center_audit_logs')->where('event', 'content.equivalence_approved')->orderBy('branch_id')->get();
            $this->assertCount(2, $logs);
            foreach ($logs as $log) {
                $details = json_decode($log->details, true);
                $this->assertSame($saved['id'], $details['record_id']);
                $this->assertSame('تمت مراجعة المحتوى الأكاديمي الكامل.', $details['reason']);
                $this->assertCount(1, $details['after']);
                $this->assertSame($log->branch_id === $this->north ? ['source'] : ['target'], array_keys($details['after']));
                $local = reset($details['after']);
                $this->assertSame($log->branch_id === $this->north ? 'Letters' : 'Alphabet', $local['lectures'][0]['content']);
            }
        });
        $this->actingAs($this->owner, 'web')->withSession(['center_id' => $this->center->id]);
        $this->patchJson("{$this->base}/levels/{$source['id']}/first-plan", [
            'revision' => 1, 'plan_version_id' => $source['plan']['id'],
            'lectures' => [['number' => 1, 'content' => 'Changed after approval', 'planned_hours' => 1]],
        ])->assertConflict()->assertJsonPath('code', 'plan_used');
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asStaff();
        $this->getJson($path)->assertOk()->assertJsonCount(0, 'approvals');
        $this->postJson($path, $payload)->assertNotFound();
    }

    public function test_invalid_lectures_and_revoked_approval_do_not_create_records(): void
    {
        $source = $this->plan($this->north, 'Same names', ['One']);
        $target = $this->plan($this->north, 'Same names', ['One']);
        $path = "{$this->base}/content-equivalences";
        $payload = $this->payload($source, $target);
        $this->postJson($path, [...$payload, 'source_lecture_ids' => [$target['plan']['lectures'][0]['id']]])->assertUnprocessable();
        $this->postJson($path, [...$payload, 'target_plan_version_id' => $source['plan']['id']])->assertUnprocessable();
        $this->postJson($path, [...$payload, 'reason' => '  '])->assertUnprocessable();
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asStaff();
        $this->getJson($path)->assertOk()->assertJsonCount(2, 'options');
        $this->postJson($path, $payload)->assertForbidden();
        $this->center->run(fn () => $this->assertSame(0, DB::table('content_equivalences')->count()));
    }

    public function test_workspace_query_count_stays_flat_as_approvals_accumulate(): void
    {
        $source = $this->plan($this->north, 'Source', ['Letters', 'Words']);
        $target = $this->plan($this->south, 'Target', ['Alphabet', 'Reading']);
        $path = "{$this->base}/content-equivalences";
        $empty = $this->getJson($path)->assertOk()->assertJsonCount(0, 'approvals');
        $emptyQueries = (int) $empty->headers->get('X-Courses-Query-Count');
        $this->assertGreaterThan(0, $emptyQueries);

        $payload = $this->payload($source, $target);
        $this->postJson($path, $payload)->assertCreated();
        $this->postJson($path, [
            ...$payload,
            'source_lecture_ids' => [$source['plan']['lectures'][1]['id']],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->postJson($path, [
            ...$payload,
            'target_lecture_ids' => [$target['plan']['lectures'][0]['id']],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated();

        $filled = $this->getJson($path)->assertOk()->assertJsonCount(3, 'approvals');
        $this->assertSame($emptyQueries, (int) $filled->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, $emptyQueries);
    }

    public function test_migration_reaches_existing_and_new_centers(): void
    {
        $this->center->run(function (): void {
            DB::statement('DROP TABLE content_equivalences');
            DB::statement('DROP FUNCTION protect_approved_content_equivalence()');
            DB::table('migrations')->where('migration', '2026_09_28_201100_create_content_equivalences')->delete();
        });
        $this->assertSame(0, Artisan::call('courses:migrate-centers', ['--center' => 'alpha']));
        $this->center->run(fn () => $this->assertTrue(DB::getSchemaBuilder()->hasTable('content_equivalences')));
        $this->actingAs(User::factory()->platformOwner()->create(), 'platform')
            ->postJson('http://courses.test/api/v1/platform/centers', [
                'name' => 'Beta', 'slug' => 'beta', 'subdomain' => 'beta', 'plan' => 'starter', 'owner_email' => 'owner@beta.test',
            ])->assertCreated();
        $beta = Center::where('slug', 'beta')->firstOrFail();
        $beta->run(fn () => $this->assertTrue(DB::getSchemaBuilder()->hasTable('content_equivalences')));
        CenterMembership::create(['tenant_id' => $beta->id, 'user_id' => $this->owner->id, 'status' => 'active']);
        $beta->run(fn () => DB::table('center_grants')->insert(['user_id' => $this->owner->id, 'role' => 'center_owner']));
        $this->actingAs($this->owner, 'web')->withSession(['center_id' => $beta->id]);
        $this->getJson('http://beta.courses.test/api/v1/center/content-equivalences')->assertOk()->assertJsonCount(0, 'approvals');
    }

    private function plan(int $branchId, string $name, array $contents): array
    {
        $course = $this->postJson("{$this->base}/courses", [
            'branch_id' => $branchId, 'name' => $name, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", [
            'name' => 'Stage', 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('stage');

        return $this->postJson("{$this->base}/stages/{$stage['id']}/levels", [
            'name' => $name, 'request_id' => (string) Str::uuid(),
            'lectures' => array_map(fn (int $index, string $content): array => [
                'number' => $index + 1, 'content' => $content, 'planned_hours' => 1,
            ], array_keys($contents), $contents),
        ])->assertCreated()->json('level');
    }

    private function payload(array $source, array $target): array
    {
        return ['source_plan_version_id' => $source['plan']['id'],
            'target_plan_version_id' => $target['plan']['id'],
            'source_lecture_ids' => [$source['plan']['lectures'][0]['id']],
            'target_lecture_ids' => array_column($target['plan']['lectures'], 'id'),
            'reason' => 'تمت مراجعة المحتوى الأكاديمي الكامل.', 'request_id' => (string) Str::uuid()];
    }

    private function grant(array $roles): void
    {
        $this->center->run(function () use ($roles): void {
            DB::table('branch_grants')->where('user_id', $this->staff->id)->delete();
            foreach ($roles as $branchId => $branchRoles) {
                foreach ($branchRoles as $role) {
                    DB::table('branch_grants')->insert(['user_id' => $this->staff->id, 'branch_id' => $branchId, 'role' => $role]);
                }
            }
        });
    }

    private function asStaff(): void
    {
        $this->actingAs($this->staff, 'web')->withSession(['center_id' => $this->center->id]);
    }
}
