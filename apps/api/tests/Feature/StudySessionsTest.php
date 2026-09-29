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

class StudySessionsTest extends TestCase
{
    use CleansCenterDatabases, RefreshDatabase;

    private Center $center;

    private User $owner;

    private User $staff;

    private CenterMembership $membership;

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
        CenterMembership::create(['tenant_id' => $this->center->id, 'user_id' => $this->owner->id, 'status' => 'active']);
        $this->membership = CenterMembership::create(['tenant_id' => $this->center->id, 'user_id' => $this->staff->id, 'status' => 'active']);
        $this->center->run(fn () => DB::table('center_grants')->insert([
            'user_id' => $this->owner->id, 'role' => 'center_owner', 'created_at' => now(), 'updated_at' => now(),
        ]));
        $this->asUser($this->owner);
        $this->north = $this->postJson("{$this->base}/branches", ['name' => 'North', 'slug' => 'north'])->assertCreated()->json('branch.id');
        $this->south = $this->postJson("{$this->base}/branches", ['name' => 'South', 'slug' => 'south'])->assertCreated()->json('branch.id');
    }

    public function test_preview_generation_retry_and_postponement_preserve_whole_requirements_and_history(): void
    {
        $group = $this->group($this->north, 'Schedule');
        $path = "{$this->base}/groups/{$group['id']}/sessions";
        $start = now('Africa/Cairo')->addDays(14)->setTime(16, 0)->format('Y-m-d\TH:i');
        $payload = ['kind' => 'weekly', 'revision' => 1, 'start_at' => $start, 'count' => 2, 'interval_weeks' => 1];
        $preview = $this->postJson("{$path}/preview", $payload)->assertOk()->assertJsonCount(2, 'sessions')
            ->assertJsonPath('sessions.0.plan_lecture_number', 1)->assertJsonPath('sessions.1.plan_lecture_number', 2)
            ->json('sessions');
        $requestId = (string) Str::uuid();
        $saved = $this->postJson($path, [...$payload, 'request_id' => $requestId])->assertCreated()
            ->assertJsonCount(2, 'sessions')->assertJsonPath('group_revision', 2)->json('sessions');
        $this->assertSame(strtotime($preview[0]['scheduled_at']), strtotime($saved[0]['scheduled_at']));
        $this->postJson($path, [...$payload, 'request_id' => $requestId])->assertOk()->assertJsonCount(2, 'sessions')
            ->assertJsonPath('group_revision', 2);
        $this->postJson($path, [...$payload, 'count' => 1, 'request_id' => $requestId])
            ->assertConflict()->assertJsonPath('code', 'session_request_changed');
        $this->postJson($path, [...$payload, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'group_changed');
        $workspace = $this->getJson($path)->assertOk()->assertJsonCount(2, 'sessions')
            ->assertJsonPath('group.requirements.2.number', 3);
        $this->assertNotNull($workspace->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $workspace->headers->get('X-Courses-Query-Count'));
        $single = ['kind' => 'single', 'revision' => 2,
            'start_at' => now('Africa/Cairo')->addDays(17)->setTime(17, 0)->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 3, 'title' => 'مراجعة ختامية'];
        $this->postJson($path, [...$single, 'request_id' => (string) Str::uuid()])
            ->assertCreated()->assertJsonPath('sessions.0.plan_lecture_number', 3)
            ->assertJsonPath('sessions.0.title', 'مراجعة ختامية');
        $this->postJson("{$path}/preview", [...$single, 'revision' => 3])->assertUnprocessable();
        $this->center->run(fn () => $this->assertSame(3, DB::table('study_sessions')->count()));

        $newTime = now('Africa/Cairo')->addDays(24)->setTime(16, 0)->format('Y-m-d\TH:i');
        $move = ['revision' => 1, 'scheduled_at' => $newTime, 'reason' => 'إجازة', 'request_id' => (string) Str::uuid()];
        $moved = $this->patchJson("{$path}/{$saved[0]['id']}/postpone", $move)->assertOk()
            ->assertJsonPath('session.revision', 2)->json('session');
        $this->assertNotSame($saved[0]['scheduled_at'], $moved['scheduled_at']);
        $this->patchJson("{$path}/{$saved[0]['id']}/postpone", $move)->assertOk()->assertJsonPath('session.revision', 2)
            ->assertJsonPath('group_revision', 4);
        $this->patchJson("{$path}/{$saved[0]['id']}/postpone", [...$move, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'session_changed');
        $this->center->run(function () use ($saved): void {
            $this->assertSame(3, DB::table('study_sessions')->count());
            $this->assertSame(1, DB::table('center_audit_logs')->where('event', 'study_session.postponed')->count());
            $this->assertSame(1, DB::table('study_sessions')->where('id', $saved[0]['id'])->where('revision', 2)->count());
        });
    }

    public function test_unheld_cancellation_and_linked_replacement_keep_requirement_and_history(): void
    {
        $group = $this->group($this->north, 'Cancelled', 2);
        $path = "{$this->base}/groups/{$group['id']}/sessions";
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $original = $this->postJson($path, [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $group['revision'] = 2;
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $student = $this->student();
        $this->enroll($student['id'], $group, now('Africa/Cairo')->toDateString());
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $this->travelTo($scheduled->copy()->addHour());
        $originalPath = "{$path}/{$original['id']}";
        $preview = $this->getJson("{$originalPath}/cancel-preview")->assertOk()
            ->assertJsonPath('required_count', 2)->assertJsonPath('plan_lecture_number', 1)->json();
        $cancel = ['reason' => 'المحاضر لم يتمكن من الحضور', 'decision' => 'academic',
            'group_revision' => $preview['group_revision'], 'session_revision' => $preview['session_revision'],
            'preview_token' => $preview['preview_token'], 'request_id' => (string) Str::uuid()];
        $this->postJson("{$originalPath}/cancel", [...$cancel, 'preview_token' => str_repeat('0', 64)])
            ->assertConflict()->assertJsonPath('code', 'cancel_preview_changed');
        $this->postJson("{$originalPath}/cancel", $cancel)->assertOk()
            ->assertJsonPath('session.status', 'cancelled')->assertJsonPath('session.compensation_decision', 'academic')
            ->assertJsonPath('group_revision', 4);
        $this->postJson("{$originalPath}/cancel", $cancel)->assertOk();
        $this->postJson("{$originalPath}/cancel", [...$cancel, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'session_changed');
        $workspace = $this->getJson($path)->assertOk()->assertJsonPath('sessions.0.status', 'cancelled')
            ->assertJsonPath('sessions.0.cancellation_reason', $cancel['reason'])
            ->assertJsonPath('group.scheduled_requirements.0', 1);
        $this->assertLessThanOrEqual(6, (int) $workspace->headers->get('X-Courses-Query-Count'));
        $this->postJson($path, ['kind' => 'single', 'revision' => 4,
            'start_at' => now('Africa/Cairo')->addDays(4)->format('Y-m-d\\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid()])->assertUnprocessable();
        $coverage = $this->getJson("{$this->base}/groups/{$group['id']}/coverage")->assertOk()
            ->assertJsonPath('group.required_count', 2)->json('students');
        $this->assertSame(0, collect($coverage)->firstWhere('student_id', $student['id'])['covered_count']);
        $absence = $this->getJson("{$this->base}/absence-review?view=all&group_id={$group['id']}")->assertOk()->json('students');
        $this->assertSame(0, collect($absence)->firstWhere('student_id', $student['id'])['total_absences']);

        $replacementAt = now('Africa/Cairo')->addDays(3)->setTime(17, 0)->format('Y-m-d\\TH:i');
        $replacement = ['start_at' => $replacementAt, 'title' => 'تعويض اللقاء الملغى'];
        $replacementPreview = $this->postJson("{$originalPath}/replacement-preview", $replacement)->assertOk()
            ->assertJsonPath('plan_lecture_number', 1)->assertJsonPath('number', 2)->json();
        $booking = [...$replacement, 'group_revision' => $replacementPreview['group_revision'],
            'session_revision' => $replacementPreview['session_revision'],
            'preview_token' => $replacementPreview['preview_token'], 'request_id' => (string) Str::uuid()];
        $this->postJson("{$originalPath}/replacement", [...$booking, 'preview_token' => str_repeat('0', 64)])
            ->assertConflict()->assertJsonPath('code', 'replacement_preview_changed');
        $saved = $this->postJson("{$originalPath}/replacement", $booking)->assertCreated()
            ->assertJsonPath('session.replaces_session_id', $original['id'])
            ->assertJsonPath('session.plan_lecture_number', 1)->assertJsonPath('group_revision', 5)->json('session');
        $this->postJson("{$originalPath}/replacement", $booking)->assertOk()
            ->assertJsonPath('session.id', $saved['id']);
        $this->postJson("{$originalPath}/replacement", [...$booking, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'replacement_exists');
        $this->travelTo(now('Africa/Cairo')->addDays(4));
        $attendance = "{$path}/{$saved['id']}/attendance";
        $roster = $this->getJson($attendance)->assertOk()->json('students');
        $attemptId = collect($roster)->firstWhere('student_id', $student['id'])['attempt_id'];
        $this->postJson($attendance, ['attempt_id' => $attemptId, 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->postJson("{$path}/{$saved['id']}/close", ['revision' => 2, 'request_id' => (string) Str::uuid()])->assertOk();
        $coverage = $this->getJson("{$this->base}/groups/{$group['id']}/coverage")->assertOk()->json('students');
        $this->assertSame(1, collect($coverage)->firstWhere('student_id', $student['id'])['covered_count']);
        $revokePreview = $this->getJson("{$path}/{$saved['id']}/revoke-preview")->assertOk()->json();
        $this->postJson("{$path}/{$saved['id']}/revoke", [
            'reason' => 'اعتماد المحاضرة البديلة كان خاطئًا',
            'group_revision' => $revokePreview['group_revision'],
            'session_revision' => $revokePreview['session_revision'],
            'preview_token' => $revokePreview['preview_token'],
            'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $coverage = $this->getJson("{$this->base}/groups/{$group['id']}/coverage")->assertOk()->json('students');
        $this->assertSame(0, collect($coverage)->firstWhere('student_id', $student['id'])['covered_count']);
        $nextPath = "{$path}/{$saved['id']}";
        $next = ['start_at' => now('Africa/Cairo')->addDays(5)->setTime(18, 0)->format('Y-m-d\\TH:i'),
            'title' => 'بديل بعد إلغاء الاعتماد'];
        $nextPreview = $this->postJson("{$nextPath}/replacement-preview", $next)->assertOk()
            ->assertJsonPath('number', 3)->assertJsonPath('plan_lecture_number', 1)->json();
        $nextBooking = [...$next, 'group_revision' => $nextPreview['group_revision'],
            'session_revision' => $nextPreview['session_revision'],
            'preview_token' => $nextPreview['preview_token'], 'request_id' => (string) Str::uuid()];
        $third = $this->postJson("{$nextPath}/replacement", $nextBooking)->assertCreated()
            ->assertJsonPath('session.replaces_session_id', $saved['id'])
            ->assertJsonPath('session.plan_lecture_number', 1)->json('session');
        $this->postJson("{$nextPath}/replacement", $nextBooking)->assertOk()
            ->assertJsonPath('session.id', $third['id']);
        $this->postJson("{$originalPath}/replacement-preview", $next)
            ->assertConflict()->assertJsonPath('code', 'replacement_exists');
        $this->getJson($path)->assertOk()->assertJsonPath('group.required_count', 2)
            ->assertJsonPath('sessions.2.replaces_session_number', 2);
        $this->center->run(function () use ($original, $saved): void {
            $this->assertSame(3, DB::table('study_sessions')->count());
            $this->assertSame($original['id'], DB::table('study_sessions')->where('id', $saved['id'])->value('replaces_session_id'));
            $this->assertSame(1, DB::table('center_audit_logs')->where('event', 'study_session.cancelled')->count());
            $this->assertSame(2, DB::table('center_audit_logs')->where('event', 'study_session.replacement_scheduled')->count());
            $this->assertSame(0, DB::table('student_payments')->count());
        });
    }

    public function test_group_specific_full_lecture_changes_student_percentage_without_changing_other_groups(): void
    {
        $group = $this->group($this->north, 'Additional lecture', 10);
        $other = $this->group($this->north, 'Unchanged lecture count', 10);
        $path = "{$this->base}/groups/{$group['id']}";
        $start = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $sessions = $this->postJson("{$path}/sessions", [
            'kind' => 'weekly', 'revision' => 1, 'start_at' => $start->format('Y-m-d\\TH:i'),
            'count' => 8, 'interval_weeks' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions');
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $student = $this->student();
        $this->enroll($student['id'], [...$group, 'revision' => 2], now('Africa/Cairo')->toDateString());
        $this->postJson("{$path}/start", ['revision' => 2])->assertOk();
        $this->travelTo($start->copy()->addWeeks(8));
        foreach ($sessions as $session) {
            $attendance = "{$path}/sessions/{$session['id']}/attendance";
            $attempt = collect($this->getJson($attendance)->assertOk()->json('students'))
                ->firstWhere('student_id', $student['id'])['attempt_id'];
            $this->postJson($attendance, ['attempt_id' => $attempt, 'status' => 'counted',
                'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated();
        }
        $this->getJson("{$path}/coverage")->assertOk()->assertJsonPath('students.0.covered_count', 8)
            ->assertJsonPath('students.0.required_count', 10)->assertJsonPath('students.0.percentage', 80);
        $change = ['kind' => 'add', 'content' => 'امتداد شرح المنهج', 'title' => 'محاضرة إضافية',
            'reason' => 'الشرح يحتاج لقاء كاملًا إضافيًا'];
        $preview = $this->postJson("{$path}/requirements/preview", $change)->assertOk()
            ->assertJsonPath('before.required_count', 10)->assertJsonPath('after.required_count', 11)
            ->assertJsonPath('students.0.before_percentage', 80)
            ->assertJsonPath('students.0.after_percentage', 72.73)
            ->assertJsonPath('students.0.before_open_count', 8)
            ->assertJsonPath('students.0.before_provisional', true)
            ->assertJsonPath('students.0.after_provisional', false)
            ->assertJsonPath('students.0.after_needed', 9)->json();
        $confirmation = [...$change, 'group_revision' => $preview['group_revision'],
            'preview_token' => $preview['preview_token'], 'request_id' => (string) Str::uuid()];
        $this->postJson("{$path}/requirements", [...$confirmation, 'preview_token' => str_repeat('0', 64)])
            ->assertConflict();
        $saved = $this->postJson("{$path}/requirements", $confirmation)->assertCreated()
            ->assertJsonPath('requirement.number', 11)->assertJsonPath('group_revision', 4)->json();
        $this->center->run(function () use ($confirmation): void {
            $history = DB::table('study_group_requirement_impacts')
                ->where('request_id', $confirmation['request_id'])->firstOrFail();
            $this->assertSame(8, $history->before_covered);
            $this->assertSame(10, $history->before_required);
            $this->assertSame(11, $history->after_required);
            $this->assertSame('80.00', $history->before_percentage);
            $this->assertSame('72.73', $history->after_percentage);
            $this->assertSame(9, $history->after_needed);
            $this->assertSame(8, $history->before_open_count);
            $this->assertTrue($history->before_provisional);
        });
        $this->postJson("{$path}/requirements", $confirmation)->assertOk()
            ->assertJsonPath('requirement.id', $saved['requirement']['id']);
        $this->getJson("{$path}/coverage")->assertOk()->assertJsonPath('students.0.covered_count', 8)
            ->assertJsonPath('students.0.required_count', 11)->assertJsonPath('students.0.percentage', 72.73)
            ->assertJsonPath('students.0.eligible', false);
        $this->getJson("{$path}/sessions")->assertOk()->assertJsonPath('group.required_count', 11)
            ->assertJsonPath('group.requirements.10.number', 11);
        $extraTime = now('Africa/Cairo')->addDays(14)->setTime(18, 0);
        $extra = $this->postJson("{$path}/sessions", [
            'kind' => 'single', 'revision' => 4, 'start_at' => $extraTime->format('Y-m-d\\TH:i'),
            'plan_lecture_number' => 11, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->assertJsonPath('sessions.0.plan_lecture_number', 11)->json('sessions.0');
        $this->travelTo($extraTime->copy()->addHour());
        $attendance = "{$path}/sessions/{$extra['id']}/attendance";
        $attempt = collect($this->getJson($attendance)->assertOk()->json('students'))
            ->firstWhere('student_id', $student['id'])['attempt_id'];
        $this->postJson($attendance, ['attempt_id' => $attempt, 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->getJson("{$path}/coverage")->assertOk()->assertJsonPath('students.0.covered_count', 9)
            ->assertJsonPath('students.0.required_count', 11)->assertJsonPath('students.0.percentage', 81.82)
            ->assertJsonPath('students.0.eligible', true);
        $currentGroup = $this->getJson("{$path}/sessions")->assertOk()->json('group');
        $this->patchJson("{$path}/settings", [
            'revision' => $currentGroup['revision'], 'approved_price' => '100.00',
            'completion_threshold' => 60, 'instructor_ids' => array_column($group['instructors'], 'id'),
        ])->assertOk();
        $thresholdPath = "{$path}/completion-threshold";
        $thresholdChange = ['attempt_ids' => [$attempt], 'reason' => 'تطبيق الحد بعد زيادة محاضرة المجموعة'];
        $thresholdPreview = $this->postJson("{$thresholdPath}/preview", $thresholdChange)->assertOk()
            ->assertJsonPath('required_count', 11)
            ->assertJsonPath('students.0.covered_count', 9)
            ->assertJsonPath('students.0.before_needed', 9)
            ->assertJsonPath('students.0.after_needed', 7)->json();
        $this->postJson($thresholdPath, [...$thresholdChange,
            'preview_token' => $thresholdPreview['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('required_count', 11);
        $this->getJson("{$this->base}/groups/{$other['id']}/coverage")->assertOk()
            ->assertJsonPath('group.required_count', 10);
        $this->center->run(fn () => $this->assertSame(0, DB::table('student_payments')->count()));
    }

    public function test_final_cancellation_and_count_reduction_commit_together_and_preserve_history(): void
    {
        $group = $this->group($this->north, 'Final cancellation', 2);
        $path = "{$this->base}/groups/{$group['id']}";
        $session = $this->postJson("{$path}/sessions", [
            'kind' => 'single', 'revision' => 1,
            'start_at' => now('Africa/Cairo')->addDays(14)->setTime(16, 0)->format('Y-m-d\\TH:i'),
            'plan_lecture_number' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $change = ['kind' => 'reduce', 'session_id' => $session['id'], 'decision' => 'none',
            'reason' => 'تعذر عقد المحاضرة ولن يوجد بديل'];
        $preview = $this->postJson("{$path}/requirements/preview", $change)->assertOk()
            ->assertJsonPath('before.required_count', 2)->assertJsonPath('after.required_count', 1)
            ->assertJsonPath('session.status', 'planned')->json();
        $confirmation = [...$change, 'group_revision' => $preview['group_revision'],
            'preview_token' => $preview['preview_token'], 'request_id' => (string) Str::uuid()];
        $this->postJson("{$path}/requirements", $confirmation)->assertOk()
            ->assertJsonPath('session.status', 'cancelled')->assertJsonPath('group_revision', 3);
        $this->postJson("{$path}/requirements", $confirmation)->assertOk();
        $this->getJson("{$path}/coverage")->assertOk()->assertJsonPath('group.required_count', 1)
            ->assertJsonCount(1, 'group.requirements');
        $this->getJson("{$path}/sessions")->assertOk()->assertJsonPath('group.required_count', 1)
            ->assertJsonPath('sessions.0.cancellation_reason', $change['reason']);
        $this->center->run(function () use ($session): void {
            $row = DB::table('study_sessions')->where('id', $session['id'])->firstOrFail();
            $this->assertSame('cancelled', $row->status);
            $this->assertSame(1, DB::table('study_group_requirements')->whereNotNull('retired_at')->count());
            $this->assertSame(1, DB::table('center_audit_logs')->where('event', 'study_group.requirements_changed')->count());
            $this->assertSame(0, DB::table('student_payments')->count());
        });
        $this->center->run(fn () => DB::table('study_groups')->where('id', $group['id'])->update(['status' => 'completed']));
        $this->postJson("{$path}/requirements", $confirmation)->assertOk()
            ->assertJsonPath('after.required_count', 1);
    }

    public function test_unreplaced_academic_cancellation_can_be_finalized_with_audited_decision_change(): void
    {
        $group = $this->group($this->north, 'Academic cancellation finalized', 2);
        $path = "{$this->base}/groups/{$group['id']}";
        $session = $this->postJson("{$path}/sessions", [
            'kind' => 'single', 'revision' => 1,
            'start_at' => now('Africa/Cairo')->addDays(14)->setTime(16, 0)->format('Y-m-d\\TH:i'),
            'plan_lecture_number' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $cancelPreview = $this->getJson("{$path}/sessions/{$session['id']}/cancel-preview")->assertOk()->json();
        $this->postJson("{$path}/sessions/{$session['id']}/cancel", [
            'reason' => 'تعذر عقد المحاضرة', 'decision' => 'academic',
            'group_revision' => $cancelPreview['group_revision'],
            'session_revision' => $cancelPreview['session_revision'],
            'preview_token' => $cancelPreview['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $change = ['kind' => 'reduce', 'session_id' => $session['id'], 'decision' => 'none',
            'reason' => 'لن يتوفر موعد بديل للمحاضرة الملغاة'];
        $preview = $this->postJson("{$path}/requirements/preview", $change)->assertOk()
            ->assertJsonPath('session.compensation_decision', 'academic')->json();
        $this->postJson("{$path}/requirements", [...$change,
            'group_revision' => $preview['group_revision'], 'preview_token' => $preview['preview_token'],
            'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('session.compensation_decision', 'none');
        $this->center->run(function () use ($session): void {
            $this->assertSame('none', DB::table('study_sessions')->where('id', $session['id'])->value('compensation_decision'));
            $decision = json_decode(DB::table('center_audit_logs')
                ->where('event', 'study_group.requirements_changed')->value('details'), true);
            $this->assertSame('academic', $decision['previous_decision']);
            $this->assertSame('none', $decision['decision']);
        });
    }

    public function test_group_requirement_change_rechecks_branch_revision_and_rolls_back_on_audit_failure(): void
    {
        $north = $this->group($this->north, 'Requirement scope', 2);
        $south = $this->group($this->south, 'Hidden requirement', 2);
        $path = "{$this->base}/groups/{$north['id']}";
        $change = ['kind' => 'add', 'content' => 'تطبيق إضافي', 'reason' => 'المحتوى يحتاج محاضرة كاملة'];
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->postJson("{$path}/requirements/preview", $change)->assertForbidden();
        $this->postJson("{$this->base}/groups/{$south['id']}/requirements/preview", $change)->assertNotFound();
        $deniedConfirmation = [...$change, 'group_revision' => 1,
            'preview_token' => str_repeat('0', 64), 'request_id' => (string) Str::uuid()];
        $this->postJson("{$path}/requirements", $deniedConfirmation)->assertForbidden();
        $this->postJson("{$this->base}/groups/{$south['id']}/requirements", $deniedConfirmation)->assertNotFound();
        $this->grant([$this->north => ['academic_admin']]);
        $this->asUser($this->staff);
        $this->postJson("{$path}/requirements/preview", $change)->assertOk();
        $this->postJson("{$this->base}/groups/{$south['id']}/requirements/preview", $change)->assertNotFound();
        $this->asUser($this->owner);
        $stale = $this->postJson("{$path}/requirements/preview", $change)->assertOk()->json();
        $this->postJson("{$path}/sessions", [
            'kind' => 'single', 'revision' => 1,
            'start_at' => now('Africa/Cairo')->addDays(15)->setTime(16, 0)->format('Y-m-d\\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->postJson("{$path}/requirements", [...$change, 'group_revision' => $stale['group_revision'],
            'preview_token' => $stale['preview_token'], 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'group_changed');
        $preview = $this->postJson("{$path}/requirements/preview", $change)->assertOk()->json();
        $requestId = (string) Str::uuid();
        $confirmation = [...$change, 'group_revision' => $preview['group_revision'],
            'preview_token' => $preview['preview_token'], 'request_id' => $requestId];
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT requirement_audit_failure CHECK (event <> 'study_group.requirements_changed') NOT VALID"));
        try {
            $this->postJson("{$path}/requirements", $confirmation)->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT requirement_audit_failure'));
        }
        $this->center->run(function () use ($north, $requestId): void {
            $this->assertSame(2, DB::table('study_group_requirements')->where('group_id', $north['id'])->count());
            $this->assertSame(0, DB::table('study_group_requirement_submissions')->where('request_id', $requestId)->count());
            $this->assertSame(0, DB::table('study_group_requirement_impacts')->where('request_id', $requestId)->count());
            $this->assertSame(2, (int) DB::table('study_groups')->where('id', $north['id'])->value('revision'));
        });
        $this->postJson("{$path}/requirements", $confirmation)->assertCreated();
        $this->postJson("{$path}/requirements", [...$confirmation, 'content' => 'طلب مختلف'])
            ->assertConflict()->assertJsonPath('code', 'requirement_request_changed');
    }

    public function test_requirement_confirmation_rejects_attendance_changed_after_preview(): void
    {
        $group = $this->group($this->north, 'Attendance changed', 2);
        $path = "{$this->base}/groups/{$group['id']}";
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $session = $this->postJson("{$path}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $student = $this->student();
        $this->enroll($student['id'], [...$group, 'revision' => 2], now('Africa/Cairo')->toDateString());
        $this->postJson("{$path}/start", ['revision' => 2])->assertOk();
        $change = ['kind' => 'add', 'content' => 'لقاء إضافي', 'reason' => 'الحاجة إلى لقاء كامل إضافي'];
        $preview = $this->postJson("{$path}/requirements/preview", $change)->assertOk()
            ->assertJsonPath('students.0.covered_count', 0)->json();
        $this->travelTo($scheduled->copy()->addHour());
        $attendance = "{$path}/sessions/{$session['id']}/attendance";
        $attempt = collect($this->getJson($attendance)->assertOk()->json('students'))
            ->firstWhere('student_id', $student['id'])['attempt_id'];
        $this->postJson($attendance, ['attempt_id' => $attempt, 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->postJson("{$path}/requirements", [...$change,
            'group_revision' => $preview['group_revision'], 'preview_token' => $preview['preview_token'],
            'request_id' => (string) Str::uuid(),
        ])->assertConflict()->assertJsonPath('code', 'requirement_preview_changed');
        $this->postJson("{$path}/requirements/preview", $change)->assertOk()
            ->assertJsonPath('students.0.covered_count', 1);
    }

    public function test_requirement_impact_pages_students_without_changing_confirmation_token(): void
    {
        $group = $this->group($this->north, 'Paged impact', 2);
        $path = "{$this->base}/groups/{$group['id']}";
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        for ($index = 0; $index < 21; $index++) {
            $student = $this->student();
            $this->enroll($student['id'], $group, now('Africa/Cairo')->toDateString());
        }
        $change = ['kind' => 'add', 'content' => 'تطبيق إضافي', 'reason' => 'احتاج المستوى إلى لقاء إضافي'];
        $first = $this->postJson("{$path}/requirements/preview", $change)->assertOk()
            ->assertJsonCount(20, 'students')->assertJsonPath('pagination.total', 21)
            ->assertJsonPath('pagination.has_more', true)->json();
        $second = $this->postJson("{$path}/requirements/preview", [...$change, 'page' => 2])->assertOk()
            ->assertJsonCount(1, 'students')->assertJsonPath('pagination.has_more', false)->json();
        $this->assertSame($first['preview_token'], $second['preview_token']);
        $searched = $this->postJson("{$path}/requirements/preview", [
            ...$change, 'q' => (string) $first['students'][0]['student_number'],
        ])->assertOk()->assertJsonCount(1, 'students')->assertJsonPath('affected_total', 21)
            ->assertJsonPath('pagination.total', 1)->json();
        $this->assertSame($first['preview_token'], $searched['preview_token']);
        $requestId = (string) Str::uuid();
        $this->postJson("{$path}/requirements", [...$change, 'group_revision' => $second['group_revision'],
            'preview_token' => $second['preview_token'], 'request_id' => $requestId,
        ])->assertCreated()->assertJsonCount(20, 'students')->assertJsonPath('pagination.total', 21);
        $this->center->run(fn () => $this->assertSame(21, DB::table('study_group_requirement_impacts')
            ->where('request_id', $requestId)->count()));
    }

    public function test_cancellation_enforces_branch_scope_stale_preview_and_atomic_financial_decision(): void
    {
        $north = $this->group($this->north, 'North cancellation', 2);
        $south = $this->group($this->south, 'South cancellation', 2);
        $start = now('Africa/Cairo')->addDays(14)->setTime(16, 0)->format('Y-m-d\\TH:i');
        $northSession = $this->postJson("{$this->base}/groups/{$north['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $start,
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $southSession = $this->postJson("{$this->base}/groups/{$south['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $start,
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $northPath = "{$this->base}/groups/{$north['id']}/sessions/{$northSession['id']}";
        $southPath = "{$this->base}/groups/{$south['id']}/sessions/{$southSession['id']}";
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->getJson("{$northPath}/cancel-preview")->assertForbidden();
        $this->getJson("{$southPath}/cancel-preview")->assertNotFound();
        $this->grant([$this->north => ['academic_admin']]);
        $this->asUser($this->staff);
        $this->getJson("{$southPath}/cancel-preview")->assertNotFound();
        $this->postJson("{$southPath}/cancel", [
            'reason' => 'إلغاء غير مصرح', 'decision' => 'none', 'group_revision' => 2,
            'session_revision' => 1, 'preview_token' => str_repeat('0', 64), 'request_id' => (string) Str::uuid(),
        ])->assertNotFound();
        $this->asUser($this->owner);
        $stale = $this->getJson("{$northPath}/cancel-preview")->assertOk()->json();
        $this->patchJson("{$northPath}/postpone", [
            'revision' => 1, 'scheduled_at' => now('Africa/Cairo')->addDays(16)->setTime(16, 0)->format('Y-m-d\\TH:i'),
            'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->postJson("{$northPath}/cancel", [
            'reason' => 'موعد تغير بعد المعاينة', 'decision' => 'financial',
            'group_revision' => $stale['group_revision'], 'session_revision' => $stale['session_revision'],
            'preview_token' => $stale['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertConflict()->assertJsonPath('code', 'session_changed');
        $preview = $this->getJson("{$northPath}/cancel-preview")->assertOk()->json();
        $cancel = ['reason' => 'تعذر عقد الموعد بعد التأجيل', 'decision' => 'financial',
            'group_revision' => $preview['group_revision'], 'session_revision' => $preview['session_revision'],
            'preview_token' => $preview['preview_token'], 'request_id' => (string) Str::uuid()];
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT cancel_audit_failure CHECK (event <> 'study_session.cancelled') NOT VALID"));
        try {
            $this->postJson("{$northPath}/cancel", $cancel)->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT cancel_audit_failure'));
        }
        $this->center->run(function () use ($northSession, $cancel): void {
            $this->assertSame('planned', DB::table('study_sessions')->where('id', $northSession['id'])->value('status'));
            $this->assertSame(0, DB::table('study_session_submissions')->where('request_id', $cancel['request_id'])->count());
        });
        $this->postJson("{$northPath}/cancel", $cancel)->assertOk()
            ->assertJsonPath('session.compensation_decision', 'financial');
        $this->postJson("{$northPath}/replacement-preview", [
            'start_at' => now('Africa/Cairo')->addDays(20)->format('Y-m-d\\TH:i'),
        ])->assertConflict()->assertJsonPath('code', 'session_changed');
        $this->center->run(function () use ($northSession): void {
            $row = DB::table('study_sessions')->where('id', $northSession['id'])->firstOrFail();
            $this->assertNotNull($row->cancelled_at);
            $this->assertNull($row->revoked_at);
            $this->assertSame($this->owner->id, (int) $row->cancelled_by);
            $this->assertSame(0, DB::table('student_payments')->count());
        });
        $this->center->run(fn () => DB::table('study_sessions')->where('id', $southSession['id'])->update([
            'status' => 'held', 'closed_at' => now(), 'closed_by' => $this->owner->id,
        ]));
        $this->getJson("{$southPath}/cancel-preview")->assertConflict()->assertJsonPath('code', 'session_changed');
    }

    public function test_scheduled_requirement_summary_remains_complete_after_session_pagination(): void
    {
        $group = $this->group($this->north, 'Paged', 22);
        $path = "{$this->base}/groups/{$group['id']}/sessions";
        $start = now('Africa/Cairo')->addDays(14)->setTime(16, 0)->format('Y-m-d\TH:i');
        $this->postJson($path, ['kind' => 'weekly', 'revision' => 1, 'start_at' => $start,
            'count' => 20, 'interval_weeks' => 1, 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->postJson($path, ['kind' => 'single', 'revision' => 2,
            'start_at' => now('Africa/Cairo')->addDays(160)->setTime(17, 0)->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 21, 'request_id' => (string) Str::uuid()])->assertCreated();
        $page = $this->getJson("{$path}?page=2")->assertOk()->assertJsonCount(1, 'sessions')
            ->assertJsonCount(21, 'group.scheduled_requirements')->assertJsonPath('group.scheduled_requirements.0', 1)
            ->assertJsonPath('group.scheduled_requirements.20', 21)->assertJsonPath('group.requirements.21.number', 22);
        $this->assertLessThanOrEqual(6, (int) $page->headers->get('X-Courses-Query-Count'));
    }

    public function test_branch_grants_and_held_sessions_prevent_cross_branch_changes(): void
    {
        $visible = $this->group($this->north, 'Visible');
        $hidden = $this->group($this->south, 'Hidden');
        $path = "{$this->base}/groups/{$visible['id']}/sessions";
        $hiddenPath = "{$this->base}/groups/{$hidden['id']}/sessions";
        $start = now('Africa/Cairo')->addDays(14)->setTime(16, 0)->format('Y-m-d\TH:i');
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->getJson($path)->assertOk();
        $this->getJson($hiddenPath)->assertNotFound();
        $this->postJson("{$path}/preview", ['kind' => 'single', 'revision' => 1, 'start_at' => $start,
            'plan_lecture_number' => 1])->assertForbidden();
        $this->grant([$this->north => ['academic_admin']]);
        $this->asUser($this->staff);
        $this->postJson($hiddenPath, ['kind' => 'single', 'revision' => 1, 'start_at' => $start,
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid()])->assertNotFound();
        $created = $this->postJson($path, ['kind' => 'single', 'revision' => 1, 'start_at' => $start,
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid()])->assertCreated()->json('sessions.0');
        $this->center->run(fn () => DB::table('study_sessions')->where('id', $created['id'])->update(['status' => 'held']));
        $this->patchJson("{$path}/{$created['id']}/postpone", [
            'revision' => 1, 'scheduled_at' => now('Africa/Cairo')->addDays(20)->format('Y-m-d\TH:i'),
            'request_id' => (string) Str::uuid(),
        ])->assertConflict()->assertJsonPath('code', 'session_changed');
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->postJson($path, ['kind' => 'single', 'revision' => 2, 'start_at' => $start,
            'plan_lecture_number' => 2, 'request_id' => (string) Str::uuid()])->assertForbidden();
    }

    public function test_attendance_stays_unrecorded_until_close_and_only_eligible_students_become_absent(): void
    {
        $group = $this->group($this->north, 'Attendance');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $path = "{$this->base}/groups/{$group['id']}/sessions";
        $session = $this->postJson($path, [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $group['revision'] = 2;
        $attendance = "{$path}/{$session['id']}/attendance";
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $first = $this->student();
        $second = $this->student();
        $late = $this->student();
        $left = $this->student();
        $this->enroll($first['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->enroll($second['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->enroll($late['id'], $group, $scheduled->copy()->addDay()->format('Y-m-d'));
        $this->enroll($left['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->center->run(fn () => DB::table('study_attempt_group_periods')
            ->where('attempt_id', DB::table('study_attempts')->where('student_id', $left['id'])->value('id'))
            ->update(['left_on' => $scheduled->format('Y-m-d')]));

        $before = $this->getJson($attendance)->assertOk()->assertJsonCount(2, 'students')
            ->assertJsonPath('students.0.status', null);
        $this->assertLessThanOrEqual(6, (int) $before->headers->get('X-Courses-Query-Count'));
        $firstAttempt = collect($before->json('students'))->firstWhere('student_id', $first['id'])['attempt_id'];
        $this->postJson($attendance, ['attempt_id' => $firstAttempt, 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertConflict();
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $group['revision'] = 3;

        $this->travelTo($scheduled->copy()->addHour());
        $this->postJson("{$this->base}/students/{$first['id']}/status", [
            'status' => 'suspended', 'reason' => 'إيقاف بعد انتهاء المحاضرة',
            'status_revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $requestId = (string) Str::uuid();
        $payload = ['attempt_id' => $firstAttempt, 'status' => 'counted', 'revision' => 1, 'request_id' => $requestId];
        $this->postJson($attendance, $payload)->assertConflict()->assertJsonPath('code', 'student_suspended_for_session');
        $this->postJson("{$this->base}/students/{$first['id']}/status", [
            'status' => 'active', 'reason' => 'فك الإيقاف قبل تسجيل حضور سابق',
            'status_revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $recorded = $this->postJson($attendance, $payload)->assertCreated()->assertJsonPath('revision', 2)->json('entry');
        $this->postJson($attendance, $payload)->assertOk()->assertJsonPath('entry.id', $recorded['id']);
        $this->grant([$this->north => ['attendance']]);
        $this->asUser($this->staff);
        $this->postJson("{$attendance}/{$recorded['id']}/undo", ['revision' => 2, 'request_id' => (string) Str::uuid()])
            ->assertConflict();
        $this->asUser($this->owner);
        $this->postJson($attendance, [...$payload, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'session_changed');
        $undoRequestId = (string) Str::uuid();
        $this->postJson("{$attendance}/{$recorded['id']}/undo", ['revision' => 2, 'request_id' => $undoRequestId])
            ->assertOk()->assertJsonPath('entry.status', null)->assertJsonPath('revision', 3);
        $this->postJson($attendance, $payload)->assertOk()->assertJsonPath('revision', 2)
            ->assertJsonPath('entry.status', 'counted')->assertJsonPath('entry.revision', 1);
        $this->postJson($attendance, [...$payload, 'revision' => 3, 'request_id' => (string) Str::uuid()])
            ->assertCreated()->assertJsonPath('revision', 4);
        $this->postJson("{$attendance}/{$recorded['id']}/undo", ['revision' => 2, 'request_id' => $undoRequestId])
            ->assertOk()->assertJsonPath('revision', 3)
            ->assertJsonPath('entry.status', null)->assertJsonPath('entry.revision', 2);
        $this->postJson("{$path}/{$session['id']}/close", ['revision' => 4, 'request_id' => (string) Str::uuid()])
            ->assertOk()->assertJsonPath('absent_count', 1)->assertJsonPath('session.status', 'held');
        $after = $this->getJson($attendance)->assertOk()->assertJsonCount(2, 'students')->json('students');
        $this->assertSame('counted', collect($after)->firstWhere('student_id', $first['id'])['status']);
        $this->assertSame('absent', collect($after)->firstWhere('student_id', $second['id'])['status']);
        $this->center->run(fn () => DB::table('study_attempt_group_periods')->where('attempt_id', $firstAttempt)
            ->update(['left_on' => $scheduled->format('Y-m-d')]));
        $historicalRoster = $this->getJson($attendance)->assertOk()->assertJsonCount(2, 'students')->json('students');
        $this->assertSame('counted', collect($historicalRoster)->firstWhere('student_id', $first['id'])['status']);
        $backdated = $this->student();
        $this->enroll($backdated['id'], $group, now('Africa/Cairo')->subDay()->format('Y-m-d'));
        $closedRoster = $this->getJson($attendance)->assertOk()->assertJsonCount(2, 'students')->json('students');
        $this->assertNull(collect($closedRoster)->firstWhere('student_id', $backdated['id']));
        $this->postJson("{$attendance}/{$recorded['id']}/undo", ['revision' => 5, 'request_id' => (string) Str::uuid()])
            ->assertConflict();
        $this->center->run(function (): void {
            $this->assertSame(2, DB::table('study_attendance_entries')->whereNotNull('status')->count());
            $this->assertSame(4, DB::table('study_attendance_events')->count());
            $this->assertSame(4, DB::table('center_audit_logs')->where('event', 'like', 'study_attendance.%')->count());
        });
    }

    public function test_attendance_search_covers_later_server_pages_without_unbounded_rows(): void
    {
        $group = $this->group($this->north, 'Roster search');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $group['revision'] = 2;
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $last = null;
        for ($index = 0; $index < 21; $index++) {
            $last = $this->student();
            $this->enroll($last['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        }
        $this->center->run(fn () => DB::table('students')->where('id', $last['id'])->update(['student_number' => 1000]));
        $last['student_number'] = 1000;
        $path = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/attendance";
        $firstPage = $this->getJson($path)->assertOk()->assertJsonCount(20, 'students')
            ->assertJsonPath('pagination.has_more', true);
        $this->assertLessThanOrEqual(6, (int) $firstPage->headers->get('X-Courses-Query-Count'));
        $this->assertNotContains($last['id'], collect($firstPage->json('students'))->pluck('student_id'));
        $secondPage = $this->getJson("{$path}?page=2")->assertOk()->assertJsonCount(1, 'students')
            ->assertJsonPath('students.0.student_id', $last['id']);
        $this->assertLessThanOrEqual(6, (int) $secondPage->headers->get('X-Courses-Query-Count'));
        $matching = $this->getJson("{$path}?q=".rawurlencode($last['name']))->assertOk()
            ->assertJsonCount(1, 'students')->assertJsonPath('students.0.student_id', $last['id']);
        $this->assertLessThanOrEqual(6, (int) $matching->headers->get('X-Courses-Query-Count'));
        $arabicNumber = strtr((string) $last['student_number'], array_combine(str_split('0123456789'), mb_str_split('٠١٢٣٤٥٦٧٨٩')));
        $byNumber = $this->getJson("{$path}?q=".rawurlencode($arabicNumber))->assertOk()
            ->assertJsonCount(1, 'students')->assertJsonPath('students.0.student_id', $last['id']);
        $this->assertLessThanOrEqual(6, (int) $byNumber->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$path}?q=".rawurlencode('١٬٠٠٠'))->assertOk()
            ->assertJsonCount(1, 'students')->assertJsonPath('students.0.student_id', $last['id']);
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $this->travelTo($scheduled->copy()->addHour());
        $recorded = $this->postJson($path, ['attempt_id' => $firstPage->json('students.0.attempt_id'),
            'status' => 'counted', 'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated()->json('entry');
        $this->postJson("{$path}/{$recorded['id']}/undo", ['revision' => 2, 'request_id' => (string) Str::uuid()])->assertOk();
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/close", [
            'revision' => 3, 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('absent_count', 21);
        $this->center->run(function () use ($recorded): void {
            $this->assertSame(21, DB::table('study_attendance_entries')->where('status', 'absent')->count());
            $this->assertSame(3, DB::table('study_attendance_entries')->where('id', $recorded['id'])->value('revision'));
            $details = json_decode(DB::table('center_audit_logs')->where('event', 'study_attendance.closed')->value('details'), true);
            $this->assertSame(21, $details['absent_count']);
            $this->assertCount(20, $details['absent_attempt_ids']);
        });
    }

    public function test_suspension_period_excludes_only_covered_sessions_and_lifting_preserves_history(): void
    {
        $group = $this->group($this->north, 'Suspension attendance');
        $firstAt = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $sessions = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'weekly', 'revision' => 1, 'start_at' => $firstAt->format('Y-m-d\TH:i'),
            'count' => 2, 'interval_weeks' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions');
        $group['revision'] = 2;
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $student = $this->student();
        $other = $this->student();
        $this->enroll($student['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->enroll($other['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $first = "{$this->base}/groups/{$group['id']}/sessions/{$sessions[0]['id']}/attendance";
        $second = "{$this->base}/groups/{$group['id']}/sessions/{$sessions[1]['id']}/attendance";
        $attempt = collect($this->getJson($first)->assertOk()->json('students'))->firstWhere('student_id', $student['id'])['attempt_id'];
        $this->travelTo($firstAt->copy()->addHour());
        $this->postJson($first, ['attempt_id' => $attempt, 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$sessions[0]['id']}/close", [
            'revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('absent_count', 1);
        $stale = $this->getJson($second)->assertOk()->json();
        $this->assertNull(collect($stale['students'])->firstWhere('student_id', $student['id'])['suspended_at']);
        $late = $this->student();
        $this->postJson("{$this->base}/students/{$student['id']}/status", [
            'status' => 'suspended', 'reason' => 'إيقاف بين المحاضرتين',
            'status_revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->postJson("{$this->base}/students/{$late['id']}/status", [
            'status' => 'suspended', 'reason' => 'إيقاف قبل الانضمام المتأخر',
            'status_revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->travelTo($firstAt->copy()->addWeek()->addHour());
        $requestId = (string) Str::uuid();
        $payload = ['attempt_id' => $attempt, 'status' => 'counted', 'revision' => $stale['session']['revision'], 'request_id' => $requestId];
        $this->postJson($second, $payload)->assertConflict()->assertJsonPath('code', 'student_suspended_for_session');
        $this->postJson($second, $payload)->assertConflict()->assertJsonPath('code', 'student_suspended_for_session');
        $covered = $this->getJson($second)->assertOk()->assertJsonCount(2, 'students');
        $this->assertLessThanOrEqual(6, (int) $covered->headers->get('X-Courses-Query-Count'));
        $row = collect($covered->json('students'))->firstWhere('student_id', $student['id']);
        $this->assertNotNull($row['suspended_at']);
        $this->assertNull($row['status']);
        $closeRequestId = (string) Str::uuid();
        $closePayload = ['revision' => 1, 'request_id' => $closeRequestId];
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$sessions[1]['id']}/close", $closePayload)
            ->assertOk()->assertJsonPath('absent_count', 1);
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$sessions[1]['id']}/close", $closePayload)
            ->assertOk()->assertJsonPath('absent_count', 1);
        $this->postJson("{$this->base}/students/{$student['id']}/status", [
            'status' => 'active', 'reason' => 'انتهاء الإيقاف',
            'status_revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->postJson("{$this->base}/students/{$late['id']}/status", [
            'status' => 'active', 'reason' => 'الالتحاق لاحقًا',
            'status_revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $group['revision'] = 3;
        $this->enroll($late['id'], $group, now('Africa/Cairo')->subWeeks(3)->format('Y-m-d'));
        $afterLift = collect($this->getJson($second)->assertOk()->json('students'))->firstWhere('student_id', $student['id']);
        $this->assertNotNull($afterLift['suspended_at']);
        $this->assertNotNull($afterLift['lifted_at']);
        $this->assertNull($afterLift['status']);
        $this->assertSame('counted', collect($this->getJson($first)->assertOk()->json('students'))
            ->firstWhere('student_id', $student['id'])['status']);
        $this->center->run(function () use ($sessions, $attempt): void {
            $this->assertSame(1, DB::table('study_attendance_entries')->where('session_id', $sessions[1]['id'])
                ->where('attempt_id', $attempt)->whereNull('status')->whereNull('recorded_by')->count());
            $this->assertSame(1, DB::table('study_attendance_entries')->where('session_id', $sessions[1]['id'])
                ->where('status', 'absent')->count());
            $this->assertSame(1, DB::table('center_audit_logs')->where('event', 'study_attendance.closed')
                ->where('details->session_id', $sessions[1]['id'])->count());
            $details = json_decode(DB::table('center_audit_logs')->where('event', 'study_attendance.closed')
                ->where('details->session_id', $sessions[1]['id'])->value('details'), true);
            $this->assertSame(1, $details['suspended_count']);
        });
        $migration = require database_path('migrations/tenant/2026_09_28_180003_backfill_suspended_closed_attendance.php');
        $this->center->run(function () use ($migration, $sessions, $attempt): void {
            DB::table('study_attendance_entries')->where('session_id', $sessions[1]['id'])
                ->where('attempt_id', $attempt)->delete();
            $closureAudit = DB::table('center_audit_logs')->where('event', 'study_attendance.closed')
                ->where('details->session_id', $sessions[1]['id']);
            $legacyDetails = json_decode($closureAudit->value('details'), true);
            unset($legacyDetails['suspended_count']);
            $closureAudit->update(['details' => json_encode($legacyDetails)]);
            $migration->up();
            $this->assertSame(1, DB::table('study_attendance_entries')->where('session_id', $sessions[1]['id'])
                ->where('attempt_id', $attempt)->whereNull('status')->count());
            $this->assertSame(2, DB::table('study_attendance_entries')->where('session_id', $sessions[1]['id'])->count());
            $backfillAudit = DB::table('center_audit_logs')->where('event', 'study_attendance.suspension_backfilled')
                ->where('details->session_id', $sessions[1]['id']);
            $this->assertSame(1, $backfillAudit->count());
            $this->assertSame(1, json_decode($backfillAudit->value('details'), true)['suspended_count']);
            $originalDetails = DB::table('center_audit_logs')->where('event', 'study_attendance.closed')
                ->where('details->session_id', $sessions[1]['id'])->value('details');
            $this->assertArrayNotHasKey('suspended_count', json_decode($originalDetails, true));
            $migration->up();
            $this->assertSame(1, $backfillAudit->count());
        });
        $this->getJson($second)->assertOk()->assertJsonCount(2, 'students');
    }

    public function test_cancelled_session_cannot_record_or_close_attendance(): void
    {
        $group = $this->group($this->north, 'Cancelled attendance');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->center->run(fn () => DB::table('study_sessions')->where('id', $session['id'])->update(['status' => 'cancelled']));
        $this->travelTo($scheduled->copy()->addHour());
        $path = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}";
        $this->postJson("{$path}/attendance", ['attempt_id' => (string) Str::uuid(), 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertConflict();
        $this->postJson("{$path}/close", ['revision' => 1, 'request_id' => (string) Str::uuid()])->assertConflict();
        $this->center->run(fn () => $this->assertSame(0, DB::table('study_attendance_entries')->count()));
    }

    public function test_waiting_group_and_group_started_after_session_cannot_accept_attendance(): void
    {
        $group = $this->group($this->north, 'Waiting attendance');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $path = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}";
        $this->travelTo($scheduled->copy()->addHour());
        $this->getJson("{$path}/attendance")->assertOk()->assertJsonPath('has_started', false);
        $this->postJson("{$path}/attendance", ['attempt_id' => (string) Str::uuid(), 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertConflict()->assertJsonPath('code', 'session_changed');
        $this->postJson("{$path}/close", ['revision' => 1, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'session_changed');
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $this->getJson("{$path}/attendance")->assertOk()->assertJsonPath('has_started', false);
        $this->postJson("{$path}/close", ['revision' => 1, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'session_changed');
        $this->center->run(fn () => $this->assertSame(0, DB::table('study_attendance_entries')->count()));
    }

    public function test_attendance_and_absence_notes_keep_versions_and_follow_event_permission(): void
    {
        $group = $this->group($this->north, 'Notes');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $group['revision'] = 2;
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $present = $this->student();
        $absent = $this->student();
        $this->enroll($present['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->enroll($absent['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $this->travelTo($scheduled->copy()->addHour());
        $attendance = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/attendance";
        $rows = $this->getJson($attendance)->assertOk()->json('students');
        $attemptId = collect($rows)->firstWhere('student_id', $present['id'])['attempt_id'];
        $entry = $this->postJson($attendance, ['attempt_id' => $attemptId, 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated()->json('entry');
        $linked = $this->getJson("{$attendance}?entry_id={$entry['id']}")->assertOk()
            ->assertJsonCount(1, 'students')->assertJsonPath('students.0.entry_id', $entry['id']);
        $this->assertLessThanOrEqual(6, (int) $linked->headers->get('X-Courses-Query-Count'));
        $noteUrl = "{$attendance}/{$entry['id']}/note";
        $request = ['body' => 'حضر بعد التواصل', 'important' => false, 'revision' => 0,
            'entry_revision' => $entry['revision'],
            'request_id' => (string) Str::uuid()];
        $note = $this->putJson($noteUrl, $request)->assertCreated()->json('note');
        $this->putJson($noteUrl, $request)->assertOk()->assertJsonPath('note.id', $note['id']);
        $this->putJson($noteUrl, [...$request, 'body' => 'تبديل الطلب'])->assertConflict()
            ->assertJsonPath('code', 'note_request_changed');
        $this->putJson($noteUrl, [...$request, 'request_id' => (string) Str::uuid()])->assertConflict()
            ->assertJsonPath('code', 'note_changed');
        $this->putJson($noteUrl, ['body' => 'حضر بانتظام', 'important' => true, 'revision' => 1,
            'entry_revision' => $entry['revision'],
            'request_id' => (string) Str::uuid()])->assertOk()->assertJsonPath('note.revision', 2);
        $this->putJson($noteUrl, ['body' => 'حضر بانتظام', 'important' => false, 'revision' => 2,
            'entry_revision' => $entry['revision'],
            'request_id' => (string) Str::uuid()])->assertOk()->assertJsonPath('note.important', false);
        $history = $this->getJson($noteUrl)->assertOk()->assertJsonPath('entry_revision', $entry['revision'])
            ->assertJsonCount(3, 'versions');
        $this->assertNotNull($history->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $history->headers->get('X-Courses-Query-Count'));
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT attendance_note_audit_failure CHECK (event <> 'student.attendance_note_updated') NOT VALID"));
        try {
            $this->putJson($noteUrl, ['body' => 'يجب التراجع عن هذا النص', 'important' => true,
                'revision' => 3, 'entry_revision' => $entry['revision'],
                'request_id' => (string) Str::uuid()])->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT attendance_note_audit_failure'));
        }
        $this->getJson($noteUrl)->assertOk()->assertJsonPath('note.revision', 3)->assertJsonCount(3, 'versions');
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/close", [
            'revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('absent_count', 1);
        $closed = $this->getJson($attendance)->assertOk()->assertJsonCount(2, 'students');
        $this->assertNotNull($closed->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $closed->headers->get('X-Courses-Query-Count'));
        $rows = $closed->json('students');
        $this->assertSame('حضر بانتظام', collect($rows)->firstWhere('student_id', $present['id'])['note_body']);
        $absentRow = collect($rows)->firstWhere('student_id', $absent['id']);
        $this->assertSame('absent', $absentRow['status']);
        $this->getJson("{$attendance}?entry_id={$absentRow['entry_id']}")->assertOk()
            ->assertJsonCount(1, 'students')->assertJsonPath('students.0.student_id', $absent['id']);
        $absentNoteUrl = "{$attendance}/{$absentRow['entry_id']}/note";
        $this->putJson($absentNoteUrl, ['body' => 'غاب بعد إغلاق الكشف', 'important' => true,
            'revision' => 0, 'entry_revision' => $absentRow['entry_revision'],
            'request_id' => (string) Str::uuid()])->assertCreated();
        $this->getJson($absentNoteUrl)->assertOk()->assertJsonPath('note.important', true);
        $presentNotesUrl = "{$this->base}/students/{$present['id']}/notes";
        $absentNotesUrl = "{$this->base}/students/{$absent['id']}/notes";
        $presentNotes = $this->getJson($presentNotesUrl)->assertOk()->assertJsonCount(1, 'entries')
            ->assertJsonPath('entries.0.id', $note['id']);
        $this->assertLessThanOrEqual(6, (int) $presentNotes->headers->get('X-Courses-Query-Count'));
        $this->getJson("{$presentNotesUrl}/{$note['id']}")->assertOk()->assertJsonCount(3, 'versions');
        $this->getJson($absentNotesUrl)->assertOk()->assertJsonCount(1, 'entries')
            ->assertJsonPath('entries.0.important', true);
        $this->getJson("{$this->base}/students/{$absent['id']}")->assertOk()->assertJsonCount(1, 'important_notes');
        $this->center->run(function (): void {
            $this->assertSame(2, DB::table('student_event_notes')->where('event_type', 'like', 'attendance:%')->count());
            $this->assertSame(4, DB::table('student_event_note_revisions')->count());
            $this->assertSame(1, DB::table('study_attendance_entries')->where('status', 'counted')->count());
            $this->assertSame(1, DB::table('study_attendance_entries')->where('status', 'absent')->count());
            $this->assertStringNotContainsString('حضر بانتظام', DB::table('center_audit_logs')
                ->where('event', 'student.attendance_note_updated')->value('details'));
        });
        $this->grant([$this->north => ['branch_auditor']]);
        $this->asUser($this->staff);
        $audit = $this->getJson("{$this->base}/branches/{$this->north}/audit")->assertOk()->json('entries');
        $this->assertNotContains('student.attendance_note_created', collect($audit)->pluck('event'));
        $this->assertNotContains('student.attendance_note_updated', collect($audit)->pluck('event'));
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->getJson($noteUrl)->assertOk()->assertJsonCount(3, 'versions');
        $this->getJson($presentNotesUrl)->assertOk()->assertJsonCount(1, 'entries');
        $this->putJson($noteUrl, ['body' => 'غير مخول', 'important' => false, 'revision' => 3,
            'entry_revision' => $entry['revision'], 'request_id' => (string) Str::uuid()])->assertNotFound();
        $this->grant([$this->south => ['attendance']]);
        $this->asUser($this->staff);
        $this->getJson($noteUrl)->assertNotFound();
        $this->getJson($absentNoteUrl)->assertNotFound();
        $this->getJson($presentNotesUrl)->assertNotFound();
        $this->getJson("{$presentNotesUrl}/{$note['id']}")->assertNotFound();
        $this->putJson($noteUrl, ['body' => 'فرع آخر', 'important' => true, 'revision' => 3,
            'entry_revision' => $entry['revision'], 'request_id' => (string) Str::uuid()])->assertNotFound();
        $this->asUser($this->owner);
        $this->center->run(fn () => DB::table('study_attendance_entries')->where('id', $entry['id'])->update(['status' => null]));
        $this->getJson($noteUrl)->assertNotFound();
        $this->getJson($presentNotesUrl)->assertOk()->assertJsonCount(0, 'entries');
        $hidden = collect($this->getJson($attendance)->assertOk()->json('students'))->firstWhere('student_id', $present['id']);
        $this->assertNull($hidden['note_body']);
    }

    public function test_undo_and_replacement_do_not_relabel_an_earlier_attendance_note(): void
    {
        $group = $this->group($this->north, 'Replacement notes');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $group['revision'] = 2;
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $student = $this->student();
        $this->enroll($student['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $this->travelTo($scheduled->copy()->addHour());
        $path = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/attendance";
        $attemptId = $this->getJson($path)->assertOk()->json('students.0.attempt_id');
        $entry = $this->postJson($path, ['attempt_id' => $attemptId, 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated()->json('entry');
        $notePath = "{$path}/{$entry['id']}/note";
        $this->putJson($notePath, ['body' => 'سياق الحضور الأول', 'important' => true,
            'revision' => 0, 'entry_revision' => $entry['revision'],
            'request_id' => (string) Str::uuid()])->assertCreated();
        $this->postJson("{$path}/{$entry['id']}/undo", ['revision' => 2,
            'request_id' => (string) Str::uuid()])->assertOk();
        $this->getJson($notePath)->assertNotFound();
        $replacement = $this->postJson($path, ['attempt_id' => $attemptId, 'status' => 'not_counted',
            'revision' => 3, 'request_id' => (string) Str::uuid()])->assertCreated()->json('entry');
        $this->getJson($notePath)->assertOk()->assertJsonPath('note', null)
            ->assertJsonPath('entry_revision', $replacement['revision']);
        $this->assertNull($this->getJson($path)->assertOk()->json('students.0.note_body'));
        $this->putJson($notePath, ['body' => 'مسودة قديمة', 'important' => true,
            'revision' => 0, 'entry_revision' => $entry['revision'],
            'request_id' => (string) Str::uuid()])->assertConflict()
            ->assertJsonPath('code', 'attendance_occurrence_changed');
        $this->getJson($notePath)->assertOk()->assertJsonPath('note', null);
        $this->putJson($notePath, ['body' => 'سياق الحضور الثاني', 'important' => false,
            'revision' => 0, 'entry_revision' => $replacement['revision'],
            'request_id' => (string) Str::uuid()])->assertCreated();
        $this->postJson("{$path}/{$entry['id']}/undo", ['revision' => 4,
            'request_id' => (string) Str::uuid()])->assertOk();
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/close", [
            'revision' => 5, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->getJson($notePath)->assertOk()->assertJsonPath('note', null);
        $this->getJson($path)->assertOk()->assertJsonPath('students.0.status', 'absent')
            ->assertJsonPath('students.0.note_body', null);
        $this->putJson($notePath, ['body' => 'مسودة ثانية قديمة', 'important' => false,
            'revision' => 0, 'entry_revision' => $replacement['revision'],
            'request_id' => (string) Str::uuid()])->assertConflict()
            ->assertJsonPath('code', 'attendance_occurrence_changed');
        $this->center->run(function (): void {
            $this->assertSame(2, DB::table('student_event_notes')->where('event_type', 'like', 'attendance:%')->count());
            $this->assertSame(2, DB::table('student_event_note_revisions')->count());
            $occurrences = DB::table('center_audit_logs')->where('event', 'student.attendance_note_created')
                ->orderBy('id')->pluck('details')->map(fn ($details) => json_decode($details, true)['entry_revision'])->all();
            $this->assertSame([1, 3], $occurrences);
        });
    }

    public function test_attendance_note_history_cursor_stays_on_the_same_occurrence_and_avoids_shifted_pages(): void
    {
        $group = $this->group($this->north, 'Note history cursor');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $group['revision'] = 2;
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $student = $this->student();
        $this->enroll($student['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $this->travelTo($scheduled->copy()->addHour());
        $attendance = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/attendance";
        $attemptId = $this->getJson($attendance)->assertOk()->json('students.0.attempt_id');
        $entry = $this->postJson($attendance, ['attempt_id' => $attemptId, 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated()->json('entry');
        $notePath = "{$attendance}/{$entry['id']}/note";
        for ($revision = 1; $revision <= 22; $revision++) {
            $this->putJson($notePath, ['body' => "Version {$revision}", 'important' => false,
                'revision' => $revision - 1, 'entry_revision' => $entry['revision'],
                'request_id' => (string) Str::uuid()])->assertSuccessful();
        }
        $first = $this->getJson($notePath)->assertOk()->assertJsonCount(20, 'versions')
            ->assertJsonPath('pagination.next_before_revision', 3);
        $this->assertLessThanOrEqual(6, (int) $first->headers->get('X-Courses-Query-Count'));
        $oldNoteId = $first->json('note.id');
        $this->putJson($notePath, ['body' => 'Version 23', 'important' => true,
            'revision' => 22, 'entry_revision' => $entry['revision'],
            'request_id' => (string) Str::uuid()])->assertOk();
        $older = $this->getJson("{$notePath}?page=2&before_revision=3")->assertOk()
            ->assertJsonCount(2, 'versions')->assertJsonPath('versions.0.revision', 2)
            ->assertJsonPath('versions.1.revision', 1)->assertJsonPath('pagination.has_more', false);
        $this->assertSame($oldNoteId, $older->json('note.id'));
        $this->postJson("{$attendance}/{$entry['id']}/undo", ['revision' => 2,
            'request_id' => (string) Str::uuid()])->assertOk();
        $replacement = $this->postJson($attendance, ['attempt_id' => $attemptId, 'status' => 'not_counted',
            'revision' => 3, 'request_id' => (string) Str::uuid()])->assertCreated()->json('entry');
        $this->putJson($notePath, ['body' => 'Replacement occurrence', 'important' => false,
            'revision' => 0, 'entry_revision' => $replacement['revision'],
            'request_id' => (string) Str::uuid()])->assertCreated();
        $changed = $this->getJson("{$notePath}?page=2&before_revision=3")->assertOk()
            ->assertJsonPath('entry_revision', $replacement['revision'])->assertJsonCount(1, 'versions')
            ->assertJsonPath('versions.0.body', 'Replacement occurrence');
        $this->assertNotSame($oldNoteId, $changed->json('note.id'));
    }

    public function test_attendance_permission_and_hidden_branch_are_enforced(): void
    {
        $visible = $this->group($this->north, 'Visible attendance');
        $hidden = $this->group($this->south, 'Hidden attendance');
        $start = now('Africa/Cairo')->addDays(14)->setTime(16, 0)->format('Y-m-d\TH:i');
        $visibleSession = $this->postJson("{$this->base}/groups/{$visible['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $start,
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $hiddenSession = $this->postJson("{$this->base}/groups/{$hidden['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $start,
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->grant([$this->north => ['branch_viewer']]);
        $this->asUser($this->staff);
        $visiblePath = "{$this->base}/groups/{$visible['id']}/sessions/{$visibleSession['id']}/attendance";
        $hiddenPath = "{$this->base}/groups/{$hidden['id']}/sessions/{$hiddenSession['id']}/attendance";
        $this->getJson($visiblePath)->assertOk()->assertJsonPath('can_record', false);
        $this->getJson($hiddenPath)->assertNotFound();
        $this->travelTo(now()->addDays(15));
        $this->postJson($visiblePath, ['attempt_id' => (string) Str::uuid(), 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertForbidden();
        $this->postJson("{$this->base}/groups/{$visible['id']}/sessions/{$visibleSession['id']}/close", [
            'revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertForbidden();
        $this->postJson($hiddenPath, ['attempt_id' => (string) Str::uuid(), 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertNotFound();
    }

    public function test_closed_attendance_correction_and_revocation_recalculate_reports_and_preserve_history(): void
    {
        $group = $this->group($this->north, 'Correction');
        $secondGroup = $this->postJson("{$this->base}/groups", [
            'level_id' => $group['level_id'], 'plan_version_id' => $group['plan_version_id'],
            'name' => 'Second correction group', 'approved_price' => '100.00',
            'instructor_ids' => array_column($group['instructors'], 'id'), 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $group['revision'] = 2;
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $student = $this->student();
        $this->enroll($student['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $suspended = $this->student();
        $this->enroll($suspended['id'], $group, now('Africa/Cairo')->format('Y-m-d'));
        $this->postJson("{$this->base}/students/{$suspended['id']}/status", [
            'status' => 'suspended', 'reason' => 'إيقاف قبل المحاضرة',
            'status_revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => 2])->assertOk();
        $this->travelTo($scheduled->copy()->addHour());
        $path = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}";
        $this->postJson("{$path}/close", ['revision' => 1, 'request_id' => (string) Str::uuid()])
            ->assertOk()->assertJsonPath('absent_count', 1);
        $workspace = $this->getJson("{$path}/attendance")->assertOk()->assertJsonPath('can_correct', true)
            ->assertJsonPath('can_revoke', true);
        $this->assertLessThanOrEqual(6, (int) $workspace->headers->get('X-Courses-Query-Count'));
        $row = collect($workspace->json('students'))->firstWhere('student_id', $student['id']);
        $absences = $this->getJson("{$this->base}/absence-review?view=all&group_id={$group['id']}")->assertOk()->json('students');
        $this->assertSame(1, collect($absences)->firstWhere('student_id', $student['id'])['total_absences']);
        $correct = ['status' => 'counted', 'reason' => 'ثبت الحضور من كشف الورق',
            'revision' => 2, 'entry_revision' => $row['entry_revision'], 'request_id' => (string) Str::uuid()];
        $this->grant([$this->north => ['attendance']]);
        $this->asUser($this->staff);
        $this->postJson("{$path}/attendance/{$row['entry_id']}/correct", $correct)->assertForbidden();
        $this->getJson("{$path}/revoke-preview")->assertForbidden();
        $this->grant([$this->south => ['academic_admin']]);
        $this->asUser($this->staff);
        $this->postJson("{$path}/attendance/{$row['entry_id']}/correct", $correct)->assertNotFound();
        $this->getJson("{$path}/revoke-preview")->assertNotFound();
        $this->asUser($this->owner);
        $this->postJson("{$path}/attendance/{$row['entry_id']}/correct", [...$correct, 'reason' => ''])
            ->assertUnprocessable();
        $this->postJson("{$path}/attendance/{$row['entry_id']}/correct", $correct)
            ->assertOk()->assertJsonPath('entry.status', 'counted')->assertJsonPath('revision', 3);
        $this->postJson("{$path}/attendance/{$row['entry_id']}/correct", $correct)
            ->assertOk()->assertJsonPath('revision', 3);
        $this->postJson("{$path}/attendance/{$row['entry_id']}/correct", [...$correct, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'session_changed');
        $coverage = $this->getJson("{$this->base}/groups/{$group['id']}/coverage")->assertOk()->json('students');
        $this->assertSame(1, collect($coverage)->firstWhere('student_id', $student['id'])['covered_count']);
        $absences = $this->getJson("{$this->base}/absence-review?view=all&group_id={$group['id']}")->assertOk()->json('students');
        $this->assertSame(0, collect($absences)->firstWhere('student_id', $student['id'])['total_absences']);
        $this->travelTo($scheduled->copy()->addDay());
        $enrollments = "{$this->base}/students/{$student['id']}/enrollments";
        $waitlistPath = "{$enrollments}/{$row['attempt_id']}/waitlist";
        $attempt = collect($this->getJson($enrollments)->assertOk()->json('attempts'))->firstWhere('id', $row['attempt_id']);
        $this->postJson($waitlistPath, [
            'entered_on' => now('Africa/Cairo')->toDateString(), 'reason' => 'نقل إلى مجموعة بديلة',
            'revision' => $attempt['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $attempt = collect($this->getJson($enrollments)->assertOk()->json('attempts'))->firstWhere('id', $row['attempt_id']);
        $this->postJson("{$enrollments}/{$row['attempt_id']}/reattach", [
            'group_id' => $secondGroup['id'], 'group_revision' => $secondGroup['revision'],
            'joined_on' => now('Africa/Cairo')->toDateString(), 'revision' => $attempt['revision'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $coverage = $this->getJson("{$this->base}/groups/{$secondGroup['id']}/coverage")->assertOk()->json('students');
        $this->assertSame(1, collect($coverage)->firstWhere('student_id', $student['id'])['covered_count']);
        $preview = $this->getJson("{$path}/revoke-preview")->assertOk()
            ->assertJsonPath('attendance.total', 1)->assertJsonPath('attendance.counted', 1)
            ->assertJsonPath('attendance.potential_coverage_records', 1)->json();
        $staleSchedule = ['kind' => 'weekly', 'revision' => $preview['group_revision'],
            'start_at' => now('Africa/Cairo')->addDays(2)->setTime(17, 0)->format('Y-m-d\TH:i'),
            'count' => 1, 'interval_weeks' => 1];
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions/preview", $staleSchedule)
            ->assertOk()->assertJsonPath('sessions.0.plan_lecture_number', 2);
        $revoke = ['reason' => 'لقاء غير صالح للاعتماد', 'session_revision' => $preview['session_revision'],
            'group_revision' => $preview['group_revision'], 'preview_token' => $preview['preview_token'],
            'request_id' => (string) Str::uuid()];
        $this->postJson("{$path}/revoke", [...$revoke, 'preview_token' => str_repeat('0', 64)])
            ->assertConflict()->assertJsonPath('code', 'revoke_preview_changed');
        $this->center->run(fn () => DB::table('study_attendance_entries')->where('id', $row['entry_id'])->increment('revision'));
        $this->postJson("{$path}/revoke", $revoke)
            ->assertConflict()->assertJsonPath('code', 'revoke_preview_changed');
        $this->center->run(fn () => DB::table('study_attendance_entries')->where('id', $row['entry_id'])->decrement('revision'));
        $this->center->run(fn () => DB::statement("ALTER TABLE center_audit_logs ADD CONSTRAINT revoke_audit_failure CHECK (event <> 'study_session.revoked') NOT VALID"));
        try {
            $this->postJson("{$path}/revoke", $revoke)->assertServerError();
        } finally {
            $this->center->run(fn () => DB::statement('ALTER TABLE center_audit_logs DROP CONSTRAINT revoke_audit_failure'));
        }
        $this->center->run(fn () => $this->assertSame('held', DB::table('study_sessions')->where('id', $session['id'])->value('status')));
        $this->postJson("{$path}/revoke", $revoke)->assertOk()->assertJsonPath('session.status', 'cancelled');
        $this->center->run(fn () => $this->assertSame($preview['group_revision'] + 1,
            DB::table('study_groups')->where('id', $group['id'])->value('revision')));
        $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            ...$staleSchedule, 'request_id' => (string) Str::uuid(),
        ])->assertConflict()->assertJsonPath('code', 'group_changed');
        $this->postJson("{$path}/revoke", $revoke)->assertOk();
        $this->postJson("{$path}/revoke", [...$revoke, 'request_id' => (string) Str::uuid()])
            ->assertConflict()->assertJsonPath('code', 'session_changed');
        $coverage = $this->getJson("{$this->base}/groups/{$secondGroup['id']}/coverage")->assertOk()->json('students');
        $this->assertSame(0, collect($coverage)->firstWhere('student_id', $student['id'])['covered_count']);
        $this->center->run(function () use ($session, $row): void {
            $saved = DB::table('study_sessions')->where('id', $session['id'])->first();
            $this->assertSame('cancelled', $saved->status);
            $this->assertNotNull($saved->closed_at);
            $this->assertNotNull($saved->revoked_at);
            $this->assertSame('counted', DB::table('study_attendance_entries')->where('id', $row['entry_id'])->value('status'));
            $this->assertSame('ثبت الحضور من كشف الورق', DB::table('study_attendance_events')->where('kind', 'correct')->value('reason'));
            $this->assertSame(1, DB::table('center_audit_logs')->where('event', 'study_session.revoked')->count());
            $this->assertSame(0, DB::table('student_payments')->count());
        });
        $attempts = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")->assertOk()->json('attempts');
        $attempt = collect($attempts)->firstWhere('id', $row['attempt_id']);
        $this->postJson("{$this->base}/students/{$student['id']}/enrollments/{$row['attempt_id']}/waitlist", [
            'entered_on' => now('Africa/Cairo')->toDateString(), 'reason' => 'انتظار بعد إلغاء اعتماد المحاضرة',
            'revision' => $attempt['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->assertJsonPath('waitlist.from_group_id', $secondGroup['id']);
        $attempts = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")->assertOk()->json('attempts');
        $attempt = collect($attempts)->firstWhere('id', $row['attempt_id']);
        $this->assertNull($attempt['current_group_id']);
        $this->postJson("{$this->base}/students/{$student['id']}/enrollments/{$row['attempt_id']}/withdraw", [
            'withdrawn_on' => now('Africa/Cairo')->toDateString(), 'reason' => 'انسحاب بعد إلغاء اعتماد المحاضرة',
            'revision' => $attempt['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('attempt.status', 'withdrawn');
        $this->center->run(fn () => $this->assertSame('counted',
            DB::table('study_attendance_entries')->where('id', $row['entry_id'])->value('status')));
    }

    public function test_makeup_booking_and_closed_proof_cover_missing_content_without_changing_original_absence(): void
    {
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $source = $this->group($this->north, 'Makeup source', 2);
        $instructorId = $this->center->run(fn () => DB::table('study_group_instructors')
            ->where('group_id', $source['id'])->value('instructor_id'));
        $target = $this->postJson("{$this->base}/groups", [
            'level_id' => $source['level_id'], 'plan_version_id' => $source['plan_version_id'],
            'name' => 'Makeup target', 'approved_price' => '100.00',
            'instructor_ids' => [$instructorId], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $student = $this->student();
        $this->enroll($student['id'], $source, now('Africa/Cairo')->toDateString());
        $attempt = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")
            ->assertOk()->json('attempts.0');
        $sourceAt = now('Africa/Cairo')->addDays(2)->setTime(16, 0);
        $targetAt = $sourceAt->copy()->addDay();
        $proofAt = $targetAt->copy()->addDay();
        $sourceSession = $this->postJson("{$this->base}/groups/{$source['id']}/sessions", [
            'kind' => 'single', 'revision' => $source['revision'], 'start_at' => $sourceAt->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $targetSessions = $this->postJson("{$this->base}/groups/{$target['id']}/sessions", [
            'kind' => 'weekly', 'revision' => $target['revision'], 'start_at' => $targetAt->format('Y-m-d\TH:i'),
            'count' => 2, 'interval_weeks' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions');
        $this->postJson("{$this->base}/groups/{$source['id']}/start", ['revision' => $source['revision'] + 1])->assertOk();
        $this->postJson("{$this->base}/groups/{$target['id']}/start", ['revision' => $target['revision'] + 1])->assertOk();
        $this->travelTo($sourceAt->copy()->addHour());
        $this->postJson("{$this->base}/groups/{$source['id']}/sessions/{$sourceSession['id']}/close", [
            'revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('absent_count', 1);
        $makeupPath = "{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/makeup";
        $options = $this->getJson($makeupPath)->assertOk()->json();
        $this->assertLessThanOrEqual(6, (int) $this->getJson($makeupPath)->headers->get('X-Courses-Query-Count'));
        $absences = $this->getJson("{$makeupPath}/absences")->assertOk()->assertJsonPath('source_absences.0.id', $sourceSession['id']);
        $this->assertLessThanOrEqual(6, (int) $absences->headers->get('X-Courses-Query-Count'));
        $session = collect($options['sessions'])->firstWhere('id', $targetSessions[0]['id']);
        $fillerSessionIds = $this->center->run(function () use ($session, $target, $targetAt): array {
            DB::table('study_sessions')->where('id', $session['id'])->update(['title' => 'Unique makeup needle']);
            $template = (array) DB::table('study_groups')->where('id', $target['id'])->first();
            $groups = [];
            $sessions = [];
            for ($number = 1; $number <= 21; $number++) {
                $groupId = (string) Str::uuid();
                $groups[] = [...$template, 'id' => $groupId, 'name' => "Other makeup group {$number}",
                    'request_id' => (string) Str::uuid()];
                $sessions[] = ['id' => (string) Str::uuid(), 'group_id' => $groupId,
                    'plan_lecture_id' => $session['plan_lecture_id'], 'number' => 1,
                    'title' => "Other lecture {$number}", 'scheduled_at' => $targetAt->copy()->addDays(30 + $number),
                    'status' => 'planned', 'created_by' => $this->owner->id,
                    'created_by_name' => $this->owner->name, 'created_at' => now(), 'updated_at' => now()];
            }
            DB::table('study_groups')->insert($groups);
            DB::table('study_sessions')->insert($sessions);

            return array_column($sessions, 'id');
        });
        $unfiltered = $this->getJson($makeupPath)->assertOk()->json('sessions');
        $this->assertNotContains($session['id'], array_column($unfiltered, 'id'));
        $filtered = $this->getJson("{$makeupPath}?q=needle")->assertOk()
            ->assertJsonPath('sessions.0.id', $session['id']);
        $this->assertLessThanOrEqual(6, (int) $filtered->headers->get('X-Courses-Query-Count'));
        $this->center->run(function () use ($fillerSessionIds, $attempt, $sourceAt): void {
            $absent = [];
            foreach ($fillerSessionIds as $index => $fillerId) {
                DB::table('study_sessions')->where('id', $fillerId)->update([
                    'scheduled_at' => $sourceAt->copy()->addMinutes($index + 1),
                    'status' => 'held', 'closed_at' => now(), 'closed_by' => $this->owner->id,
                ]);
                $absent[] = ['id' => (string) Str::uuid(), 'session_id' => $fillerId,
                    'attempt_id' => $attempt['id'], 'status' => 'absent', 'recorded_by' => $this->owner->id,
                    'recorded_at' => now(), 'created_at' => now(), 'updated_at' => now()];
            }
            DB::table('study_attendance_entries')->insert($absent);
        });
        $firstAbsences = $this->getJson("{$makeupPath}/absences?page=1")->assertOk()
            ->assertJsonCount(20, 'source_absences')->assertJsonPath('pagination.has_more', true);
        $olderAbsences = $this->getJson("{$makeupPath}/absences?page=2")->assertOk()
            ->assertJsonCount(2, 'source_absences')->assertJsonPath('pagination.has_more', false);
        $this->assertContains($sourceSession['id'], array_column($olderAbsences->json('source_absences'), 'id'));
        $this->assertLessThanOrEqual(6, (int) $firstAbsences->headers->get('X-Courses-Query-Count'));
        $this->assertLessThanOrEqual(6, (int) $olderAbsences->headers->get('X-Courses-Query-Count'));
        $booking = ['session_id' => $session['id'], 'source_session_id' => $sourceSession['id'],
            'attempt_revision' => $attempt['revision'], 'session_revision' => $session['revision'],
            'request_id' => (string) Str::uuid()];
        $this->postJson("{$makeupPath}/book", [...$booking, 'session_revision' => $session['revision'] + 1,
            'request_id' => (string) Str::uuid()])->assertConflict();
        $this->postJson("{$makeupPath}/book", $booking)->assertCreated();
        $booked = $this->getJson("{$makeupPath}?q=needle")->assertOk()
            ->assertJsonPath('sessions.0.booked_source.id', $sourceSession['id'])
            ->assertJsonPath('sessions.0.booked_source.group_name', $source['name']);
        $this->assertNotContains($sourceSession['id'], array_column($firstAbsences->json('source_absences'), 'id'));
        $this->assertLessThanOrEqual(6, (int) $booked->headers->get('X-Courses-Query-Count'));
        $this->postJson("{$makeupPath}/book", $booking)->assertOk()->assertJsonPath('replayed', true);
        $this->postJson("{$makeupPath}/book", [...$booking, 'request_id' => (string) Str::uuid()])->assertConflict();
        $coveragePath = "{$this->base}/groups/{$source['id']}/coverage";
        $this->getJson($coveragePath)->assertOk()->assertJsonPath('students.0.covered_count', 0);
        $attendance = "{$this->base}/groups/{$target['id']}/sessions/{$session['id']}/attendance";
        $this->getJson($attendance)->assertOk()->assertJsonPath('students.0.attempt_id', $attempt['id'])
            ->assertJsonPath('students.0.status', null);
        $this->travelTo($targetAt->copy()->addHour());
        $this->postJson($attendance, ['attempt_id' => $attempt['id'], 'status' => 'counted',
            'revision' => 1, 'request_id' => (string) Str::uuid()])->assertCreated();
        $this->getJson($coveragePath)->assertOk()->assertJsonPath('students.0.covered_count', 1)
            ->assertJsonPath('students.0.open_numbers', [1]);
        $this->postJson("{$this->base}/groups/{$target['id']}/sessions/{$session['id']}/close", [
            'revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('absent_count', 0);
        $this->center->run(fn () => $this->assertSame('absent', DB::table('study_attendance_entries')
            ->where('session_id', $sourceSession['id'])->where('attempt_id', $attempt['id'])->value('status')));
        $closed = $targetSessions[1];
        $this->travelTo(now('Africa/Cairo')->addWeeks(2));
        $closedPath = "{$this->base}/groups/{$target['id']}/sessions/{$closed['id']}";
        $this->postJson("{$closedPath}/close", ['revision' => 1, 'request_id' => (string) Str::uuid()])
            ->assertOk()->assertJsonPath('absent_count', 0);
        $proof = ['session_id' => $closed['id'], 'source_session_id' => null,
            'attempt_revision' => $attempt['revision'], 'session_revision' => 2,
            'reason' => 'ثبت حضوره في مجموعة التعويض', 'request_id' => (string) Str::uuid()];
        $this->postJson("{$makeupPath}/prove", [...$proof, 'source_session_id' => $sourceSession['id'],
            'request_id' => (string) Str::uuid()])->assertUnprocessable();
        $this->postJson("{$makeupPath}/prove", $proof)->assertCreated();
        $this->postJson("{$makeupPath}/prove", $proof)->assertOk()->assertJsonPath('replayed', true);
        $this->getJson($coveragePath)->assertOk()->assertJsonPath('students.0.covered_count', 2)
            ->assertJsonPath('students.0.missing_numbers', []);
        $revoke = $this->getJson("{$closedPath}/revoke-preview")->assertOk()->json();
        $this->postJson("{$closedPath}/revoke", [
            'reason' => 'إلغاء اعتماد محاضرة التعويض بعد مراجعة',
            'session_revision' => $revoke['session_revision'], 'group_revision' => $revoke['group_revision'],
            'preview_token' => $revoke['preview_token'], 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->getJson($coveragePath)->assertOk()->assertJsonPath('students.0.covered_count', 1);
        $this->center->run(function () use ($attempt): void {
            $this->assertSame(1, DB::table('study_makeup_bookings')->where('attempt_id', $attempt['id'])->whereNotNull('proved_at')->count());
            $this->assertSame(1, DB::table('center_audit_logs')->where('event', 'study_makeup.proved')->count());
            try {
                (require database_path('migrations/tenant/2026_09_29_020000_create_study_makeup_bookings.php'))->down();
                $this->fail('Rollback must preserve makeup bookings and attendance history.');
            } catch (\RuntimeException $exception) {
                $this->assertStringContainsString('Cannot roll back makeup', $exception->getMessage());
            }
            $this->assertTrue(DB::getSchemaBuilder()->hasTable('study_makeup_bookings'));
        });
        $this->grant([$this->north => ['registration']]);
        $this->asUser($this->staff);
        $this->postJson("{$makeupPath}/prove", [...$proof, 'request_id' => (string) Str::uuid()])->assertNotFound();
    }

    public function test_makeup_after_completed_primary_group_requires_equivalence_and_both_branch_permissions(): void
    {
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $source = $this->group($this->north, 'Completed source', 1);
        $target = $this->group($this->south, 'Equivalent target', 1);
        $student = $this->student();
        $this->enroll($student['id'], $source, now('Africa/Cairo')->toDateString());
        $attempt = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")->json('attempts.0');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(17, 0)->format('Y-m-d\TH:i');
        $session = $this->postJson("{$this->base}/groups/{$target['id']}/sessions", [
            'kind' => 'single', 'revision' => 1, 'start_at' => $scheduled,
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->center->run(function () use ($source, $attempt): void {
            DB::table('study_groups')->where('id', $source['id'])->update(['status' => 'completed']);
            DB::table('study_attempts')->where('id', $attempt['id'])->update(['status' => 'completed']);
        });
        $makeupPath = "{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/makeup";
        $payload = ['session_id' => $session['id'], 'attempt_revision' => $attempt['revision'],
            'session_revision' => $session['revision'], 'request_id' => (string) Str::uuid()];
        $this->postJson("{$makeupPath}/book", $payload)->assertUnprocessable();
        $sourceLecture = $this->center->run(fn () => DB::table('plan_lectures')->where('plan_version_id', $source['plan_version_id'])->value('id'));
        $targetLecture = $this->center->run(fn () => DB::table('plan_lectures')->where('plan_version_id', $target['plan_version_id'])->value('id'));
        $intermediate = $this->group($this->south, 'Unvisited intermediate plan', 1);
        $intermediateLecture = $this->center->run(fn () => DB::table('plan_lectures')
            ->where('plan_version_id', $intermediate['plan_version_id'])->value('id'));
        $this->postJson("{$this->base}/content-equivalences", [
            'source_plan_version_id' => $target['plan_version_id'],
            'target_plan_version_id' => $intermediate['plan_version_id'],
            'source_lecture_ids' => [$targetLecture], 'target_lecture_ids' => [$intermediateLecture],
            'reason' => 'معادلة إلى خطة وسيطة لم يدرسها الطالب', 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->postJson("{$this->base}/content-equivalences", [
            'source_plan_version_id' => $intermediate['plan_version_id'],
            'target_plan_version_id' => $source['plan_version_id'],
            'source_lecture_ids' => [$intermediateLecture], 'target_lecture_ids' => [$sourceLecture],
            'reason' => 'معادلة وسيطة إلى الخطة الأصلية', 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->postJson("{$makeupPath}/book", [...$payload, 'request_id' => (string) Str::uuid()])
            ->assertUnprocessable();
        $this->postJson("{$this->base}/content-equivalences", [
            'source_plan_version_id' => $target['plan_version_id'], 'target_plan_version_id' => $source['plan_version_id'],
            'source_lecture_ids' => [$targetLecture], 'target_lecture_ids' => [$sourceLecture],
            'reason' => 'معادلة تعويض المستوى المكتمل', 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->postJson("{$makeupPath}/book", [...$payload, 'attempt_revision' => $attempt['revision'] + 1,
            'request_id' => (string) Str::uuid()])->assertConflict();
        $this->postJson("{$makeupPath}/book", [...$payload, 'session_revision' => $session['revision'] + 1,
            'request_id' => (string) Str::uuid()])->assertConflict();
        $this->postJson("{$this->base}/students/{$student['id']}/status", [
            'status' => 'suspended', 'reason' => 'إيقاف التعويض بين المعاينة والتنفيذ',
            'status_revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $suspended = $this->getJson($makeupPath)->assertOk()->assertJsonPath('attempt.student_status', 'suspended');
        $this->assertFalse(collect($suspended->json('sessions'))->firstWhere('id', $session['id'])['can_book']);
        $this->assertLessThanOrEqual(6, (int) $suspended->headers->get('X-Courses-Query-Count'));
        $this->grant([$this->north => ['registration'], $this->south => ['branch_viewer']]);
        $this->asUser($this->staff);
        $this->getJson($makeupPath)->assertOk();
        $this->postJson("{$makeupPath}/book", $payload)->assertNotFound();
        $this->asUser($this->owner);
        $this->postJson("{$makeupPath}/book", $payload)->assertConflict()
            ->assertJsonPath('code', 'student_suspended_for_makeup');
        $this->center->run(fn () => $this->assertSame(0, DB::table('study_makeup_bookings')
            ->where('attempt_id', $attempt['id'])->count()));
        $this->postJson("{$this->base}/students/{$student['id']}/status", [
            'status' => 'active', 'reason' => 'فك الإيقاف قبل التعويض',
            'status_revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->postJson("{$makeupPath}/book", $payload)->assertCreated();
        $this->getJson("{$this->base}/groups/{$source['id']}/coverage")
            ->assertOk()->assertJsonPath('students.0.covered_count', 0);
        $this->postJson("{$this->base}/students/{$student['id']}/status", [
            'status' => 'suspended', 'reason' => 'إيقاف بعد الحجز قبل إعادة الطلب',
            'status_revision' => 3, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->postJson("{$makeupPath}/book", $payload)->assertConflict()
            ->assertJsonPath('code', 'student_suspended_for_makeup');
        $this->center->run(fn () => $this->assertSame(1, DB::table('study_makeup_bookings')
            ->where('attempt_id', $attempt['id'])->count()));
    }

    public function test_booked_student_who_joins_target_group_before_session_is_marked_absent_on_close(): void
    {
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $source = $this->group($this->north, 'Makeup then transfer', 1);
        $instructorId = $this->center->run(fn () => DB::table('study_group_instructors')
            ->where('group_id', $source['id'])->value('instructor_id'));
        $target = $this->postJson("{$this->base}/groups", [
            'level_id' => $source['level_id'], 'plan_version_id' => $source['plan_version_id'],
            'name' => 'Later primary group', 'approved_price' => '100.00',
            'instructor_ids' => [$instructorId], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $student = $this->student();
        $this->enroll($student['id'], $source, now('Africa/Cairo')->toDateString());
        $attempt = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")
            ->assertOk()->json('attempts.0');
        $scheduled = now('Africa/Cairo')->addDays(14)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$target['id']}/sessions", [
            'kind' => 'single', 'revision' => $target['revision'], 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->postJson("{$this->base}/groups/{$target['id']}/start", ['revision' => $target['revision'] + 1])->assertOk();
        $makeupPath = "{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/makeup";
        $this->postJson("{$makeupPath}/book", [
            'session_id' => $session['id'], 'attempt_revision' => $attempt['revision'],
            'session_revision' => $session['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $transferDate = $scheduled->copy()->subDays(2)->toDateString();
        $this->center->run(function () use ($attempt, $source, $target, $transferDate): void {
            DB::table('study_attempt_group_periods')->where('attempt_id', $attempt['id'])
                ->where('group_id', $source['id'])->update(['left_on' => $transferDate]);
            DB::table('study_attempt_group_periods')->insert([
                'id' => (string) Str::uuid(), 'attempt_id' => $attempt['id'], 'group_id' => $target['id'],
                'joined_on' => $transferDate, 'created_at' => now(),
            ]);
            DB::table('study_attempts')->where('id', $attempt['id'])->update(['current_group_id' => $target['id']]);
        });
        $withdrawnStudent = $this->student();
        $this->enroll($withdrawnStudent['id'], $source, now('Africa/Cairo')->toDateString());
        $withdrawnAttempt = $this->getJson("{$this->base}/students/{$withdrawnStudent['id']}/enrollments")
            ->assertOk()->json('attempts.0');
        $withdrawnPath = "{$this->base}/students/{$withdrawnStudent['id']}/enrollments/{$withdrawnAttempt['id']}";
        $this->postJson("{$withdrawnPath}/makeup/book", [
            'session_id' => $session['id'], 'attempt_revision' => $withdrawnAttempt['revision'],
            'session_revision' => $session['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->postJson("{$withdrawnPath}/withdraw", [
            'withdrawn_on' => now('Africa/Cairo')->toDateString(), 'reason' => 'انسحاب قبل محاضرة التعويض',
            'revision' => $withdrawnAttempt['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('attempt.status', 'withdrawn');
        $lateStudent = $this->student();
        $this->enroll($lateStudent['id'], $source, now('Africa/Cairo')->toDateString());
        $lateAttempt = $this->getJson("{$this->base}/students/{$lateStudent['id']}/enrollments")
            ->assertOk()->json('attempts.0');
        $this->travelTo($scheduled->copy()->addHour());
        $this->postJson("{$this->base}/students/{$lateStudent['id']}/enrollments/{$lateAttempt['id']}/makeup/book", [
            'session_id' => $session['id'], 'attempt_revision' => $lateAttempt['revision'],
            'session_revision' => $session['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertConflict();
        $attendance = "{$this->base}/groups/{$target['id']}/sessions/{$session['id']}/attendance";
        $this->assertNotContains($withdrawnAttempt['id'], array_column($this->getJson($attendance)
            ->assertOk()->json('students'), 'attempt_id'));
        $this->postJson($attendance, [
            'attempt_id' => $withdrawnAttempt['id'], 'status' => 'counted',
            'revision' => $session['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertNotFound();
        $this->postJson("{$this->base}/groups/{$target['id']}/sessions/{$session['id']}/close", [
            'revision' => $session['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('absent_count', 1);
        $this->getJson($attendance)->assertOk()->assertJsonPath('students.0.status', 'absent');
    }

    public function test_closed_makeup_proof_reuses_an_undone_attendance_entry(): void
    {
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $source = $this->group($this->north, 'Undone makeup source', 1);
        $instructorId = $this->center->run(fn () => DB::table('study_group_instructors')
            ->where('group_id', $source['id'])->value('instructor_id'));
        $target = $this->postJson("{$this->base}/groups", [
            'level_id' => $source['level_id'], 'plan_version_id' => $source['plan_version_id'],
            'name' => 'Undone makeup target', 'approved_price' => '100.00',
            'instructor_ids' => [$instructorId], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $student = $this->student();
        $this->enroll($student['id'], $source, now('Africa/Cairo')->toDateString());
        $attempt = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")
            ->assertOk()->json('attempts.0');
        $scheduled = now('Africa/Cairo')->addDays(3)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$target['id']}/sessions", [
            'kind' => 'single', 'revision' => $target['revision'], 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->postJson("{$this->base}/groups/{$target['id']}/start", ['revision' => $target['revision'] + 1])->assertOk();
        $makeupPath = "{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/makeup";
        $this->postJson("{$makeupPath}/book", [
            'session_id' => $session['id'], 'attempt_revision' => $attempt['revision'],
            'session_revision' => $session['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->travelTo($scheduled->copy()->addHour());
        $attendance = "{$this->base}/groups/{$target['id']}/sessions/{$session['id']}/attendance";
        $recorded = $this->postJson($attendance, [
            'attempt_id' => $attempt['id'], 'status' => 'counted', 'revision' => $session['revision'],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json();
        $undone = $this->postJson("{$attendance}/{$recorded['entry']['id']}/undo", [
            'revision' => $recorded['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('entry.status', null)->json();
        $closed = $this->postJson("{$this->base}/groups/{$target['id']}/sessions/{$session['id']}/close", [
            'revision' => $undone['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertOk()->json();
        $proof = [
            'session_id' => $session['id'], 'attempt_revision' => $attempt['revision'],
            'session_revision' => $closed['session']['revision'], 'reason' => 'إثبات بعد التراجع السابق',
            'request_id' => (string) Str::uuid(),
        ];
        $this->postJson("{$makeupPath}/prove", $proof)->assertCreated()->assertJsonPath('entry_id', $recorded['entry']['id']);
        $this->postJson("{$makeupPath}/prove", $proof)->assertOk()->assertJsonPath('replayed', true);
        $this->center->run(function () use ($attempt, $session, $recorded): void {
            $entry = DB::table('study_attendance_entries')->where('attempt_id', $attempt['id'])
                ->where('session_id', $session['id'])->sole();
            $this->assertSame($recorded['entry']['id'], $entry->id);
            $this->assertSame('counted', $entry->status);
            $this->assertSame(3, $entry->revision);
            $this->assertSame(1, DB::table('study_attendance_events')->where('session_id', $session['id'])
                ->where('kind', 'makeup_prove')->count());
        });
        $this->getJson("{$this->base}/groups/{$source['id']}/coverage")
            ->assertOk()->assertJsonPath('students.0.covered_count', 1);
    }

    public function test_closed_makeup_proof_rejects_student_suspended_at_target_session_time_after_reactivation(): void
    {
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $source = $this->group($this->north, 'Makeup suspension', 1);
        $instructorId = $this->center->run(fn () => DB::table('study_group_instructors')
            ->where('group_id', $source['id'])->value('instructor_id'));
        $target = $this->postJson("{$this->base}/groups", [
            'level_id' => $source['level_id'], 'plan_version_id' => $source['plan_version_id'],
            'name' => 'Suspended target', 'approved_price' => '100.00',
            'instructor_ids' => [$instructorId], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $student = $this->student();
        $this->enroll($student['id'], $source, now('Africa/Cairo')->toDateString());
        $attempt = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")
            ->assertOk()->json('attempts.0');
        $scheduled = now('Africa/Cairo')->addDays(3)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$target['id']}/sessions", [
            'kind' => 'single', 'revision' => $target['revision'], 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->postJson("{$this->base}/groups/{$target['id']}/start", ['revision' => $target['revision'] + 1])->assertOk();
        $this->travelTo($scheduled->copy()->subDay());
        $this->postJson("{$this->base}/students/{$student['id']}/status", [
            'status' => 'suspended', 'reason' => 'إيقاف قبل التعويض',
            'status_revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->travelTo($scheduled->copy()->addHour());
        $this->postJson("{$this->base}/groups/{$target['id']}/sessions/{$session['id']}/close", [
            'revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->postJson("{$this->base}/students/{$student['id']}/status", [
            'status' => 'active', 'reason' => 'انتهاء الإيقاف بعد المحاضرة',
            'status_revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $workspace = $this->getJson("{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/makeup")
            ->assertOk()->assertJsonPath('sessions.0.suspended_at_session', true)
            ->assertJsonPath('sessions.0.can_prove', false);
        $this->assertLessThanOrEqual(6, (int) $workspace->headers->get('X-Courses-Query-Count'));
        $this->postJson("{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/makeup/prove", [
            'session_id' => $session['id'], 'attempt_revision' => $attempt['revision'],
            'session_revision' => 2, 'reason' => 'ادعاء حضور التعويض بعد الإغلاق',
            'request_id' => (string) Str::uuid(),
        ])->assertConflict()->assertJsonPath('code', 'student_suspended_for_makeup');
        $this->center->run(function () use ($attempt, $session): void {
            $this->assertSame(0, DB::table('study_attendance_entries')->where('attempt_id', $attempt['id'])
                ->where('session_id', $session['id'])->count());
            $this->assertSame(0, DB::table('study_makeup_bookings')->where('attempt_id', $attempt['id'])
                ->where('session_id', $session['id'])->count());
        });
    }

    public function test_closed_makeup_remains_available_after_a_later_transfer_into_the_target_group(): void
    {
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $source = $this->group($this->north, 'Historical makeup source', 1);
        $instructorId = $this->center->run(fn () => DB::table('study_group_instructors')
            ->where('group_id', $source['id'])->value('instructor_id'));
        $target = $this->postJson("{$this->base}/groups", [
            'level_id' => $source['level_id'], 'plan_version_id' => $source['plan_version_id'],
            'name' => 'Historical makeup target', 'approved_price' => '100.00',
            'instructor_ids' => [$instructorId], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $student = $this->student();
        $this->enroll($student['id'], $source, now('Africa/Cairo')->toDateString());
        $attempt = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")
            ->assertOk()->json('attempts.0');
        $scheduled = now('Africa/Cairo')->addDays(3)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$target['id']}/sessions", [
            'kind' => 'single', 'revision' => $target['revision'], 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->postJson("{$this->base}/groups/{$target['id']}/start", ['revision' => $target['revision'] + 1])->assertOk();
        $this->travelTo($scheduled->copy()->addHour());
        $this->postJson("{$this->base}/groups/{$target['id']}/sessions/{$session['id']}/close", [
            'revision' => $session['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertOk()->assertJsonPath('absent_count', 0);
        $this->travelTo($scheduled->copy()->addDay()->addHour());
        $transferDate = now('Africa/Cairo')->toDateString();
        $transferPath = "{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/transfer";
        $preview = $this->getJson("{$transferPath}/preview?".http_build_query([
            'group_id' => $target['id'], 'transferred_on' => $transferDate,
        ]))->assertOk()->json('preview');
        $this->postJson($transferPath, [
            'group_id' => $target['id'], 'group_revision' => $preview['group_revision'],
            'transferred_on' => $transferDate, 'revision' => $preview['revision'],
            'preview_hash' => $preview['hash'], 'reason' => 'نقل بعد حضور التعويض',
            'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $makeupPath = "{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/makeup";
        $workspace = $this->getJson($makeupPath)->assertOk();
        $this->assertContains($session['id'], array_column($workspace->json('sessions'), 'id'));
        $this->assertLessThanOrEqual(6, (int) $workspace->headers->get('X-Courses-Query-Count'));
        $current = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")
            ->assertOk()->json('attempts.0');
        $this->postJson("{$this->base}/students/{$student['id']}/status", [
            'status' => 'suspended', 'reason' => 'إيقاف بعد محاضرة التعويض وقبل إثباتها',
            'status_revision' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->postJson("{$makeupPath}/prove", [
            'session_id' => $session['id'], 'attempt_revision' => $current['revision'],
            'session_revision' => 2, 'reason' => 'محاولة إثبات أثناء الإيقاف',
            'request_id' => (string) Str::uuid(),
        ])->assertConflict()->assertJsonPath('code', 'student_suspended_for_makeup');
        $this->postJson("{$this->base}/students/{$student['id']}/status", [
            'status' => 'active', 'reason' => 'فك الإيقاف بعد المحاضرة',
            'status_revision' => 2, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $proof = [
            'session_id' => $session['id'], 'attempt_revision' => $current['revision'],
            'session_revision' => 2, 'reason' => 'تأخر إثبات التعويض بعد النقل',
            'request_id' => (string) Str::uuid(),
        ];
        $this->postJson("{$makeupPath}/prove", $proof)->assertCreated();
        $this->postJson("{$this->base}/students/{$student['id']}/status", [
            'status' => 'suspended', 'reason' => 'إيقاف بعد إثبات التعويض قبل إعادة الطلب',
            'status_revision' => 3, 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->postJson("{$makeupPath}/prove", $proof)->assertConflict()
            ->assertJsonPath('code', 'student_suspended_for_makeup');
        $this->center->run(fn () => $this->assertSame(1, DB::table('study_attendance_events')
            ->where('session_id', $session['id'])->where('kind', 'makeup_prove')->count()));
        $this->getJson("{$this->base}/groups/{$target['id']}/coverage")
            ->assertOk()->assertJsonPath('students.0.covered_count', 1);
    }

    public function test_makeup_cannot_credit_a_session_before_the_attempt_began(): void
    {
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $source = $this->group($this->north, 'Later enrollment source', 1);
        $instructorId = $this->center->run(fn () => DB::table('study_group_instructors')
            ->where('group_id', $source['id'])->value('instructor_id'));
        $target = $this->postJson("{$this->base}/groups", [
            'level_id' => $source['level_id'], 'plan_version_id' => $source['plan_version_id'],
            'name' => 'Earlier target', 'approved_price' => '100.00',
            'instructor_ids' => [$instructorId], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $student = $this->student();
        $scheduled = now('Africa/Cairo')->addDays(3)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$target['id']}/sessions", [
            'kind' => 'single', 'revision' => $target['revision'], 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->postJson("{$this->base}/groups/{$target['id']}/start", ['revision' => $target['revision'] + 1])->assertOk();
        $this->travelTo($scheduled->copy()->addHour());
        $this->postJson("{$this->base}/groups/{$target['id']}/sessions/{$session['id']}/close", [
            'revision' => $session['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->travelTo($scheduled->copy()->addDay());
        $this->enroll($student['id'], $source, now('Africa/Cairo')->toDateString());
        $attempt = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")
            ->assertOk()->json('attempts.0');
        $makeupPath = "{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/makeup";
        $workspace = $this->getJson($makeupPath)->assertOk();
        $this->assertNotContains($session['id'], array_column($workspace->json('sessions'), 'id'));
        $this->assertLessThanOrEqual(6, (int) $workspace->headers->get('X-Courses-Query-Count'));
        $this->postJson("{$makeupPath}/prove", [
            'session_id' => $session['id'], 'attempt_revision' => $attempt['revision'],
            'session_revision' => 2, 'reason' => 'إثبات محاضرة سابقة للمحاولة',
            'request_id' => (string) Str::uuid(),
        ])->assertUnprocessable();
        $this->getJson("{$this->base}/groups/{$source['id']}/coverage")
            ->assertOk()->assertJsonPath('students.0.covered_count', 0);
    }

    public function test_regular_attendance_can_be_recorded_after_a_later_withdrawal(): void
    {
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $group = $this->group($this->north, 'Historical regular attendance', 1);
        $student = $this->student();
        $this->enroll($student['id'], $group, now('Africa/Cairo')->toDateString());
        $attempt = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")
            ->assertOk()->json('attempts.0');
        $scheduled = now('Africa/Cairo')->addDays(3)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$group['id']}/sessions", [
            'kind' => 'single', 'revision' => $group['revision'], 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->postJson("{$this->base}/groups/{$group['id']}/start", ['revision' => $group['revision'] + 1])->assertOk();
        $this->travelTo($scheduled->copy()->addDay());
        $this->postJson("{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/withdraw", [
            'withdrawn_on' => now('Africa/Cairo')->toDateString(), 'reason' => 'انسحاب بعد المحاضرة',
            'revision' => $attempt['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $attendance = "{$this->base}/groups/{$group['id']}/sessions/{$session['id']}/attendance";
        $this->assertContains($attempt['id'], array_column($this->getJson($attendance)
            ->assertOk()->json('students'), 'attempt_id'));
        $this->postJson($attendance, [
            'attempt_id' => $attempt['id'], 'status' => 'counted',
            'revision' => $session['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->assertJsonPath('entry.status', 'counted');
    }

    public function test_booked_makeup_can_be_proved_after_a_later_withdrawal(): void
    {
        $this->patchJson("{$this->base}/financial-currency", ['currency' => 'EGP', 'revision' => 1])->assertOk();
        $source = $this->group($this->north, 'Historical makeup withdrawal source', 1);
        $instructorId = $this->center->run(fn () => DB::table('study_group_instructors')
            ->where('group_id', $source['id'])->value('instructor_id'));
        $target = $this->postJson("{$this->base}/groups", [
            'level_id' => $source['level_id'], 'plan_version_id' => $source['plan_version_id'],
            'name' => 'Historical makeup withdrawal target', 'approved_price' => '100.00',
            'instructor_ids' => [$instructorId], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
        $student = $this->student();
        $this->enroll($student['id'], $source, now('Africa/Cairo')->toDateString());
        $attempt = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")
            ->assertOk()->json('attempts.0');
        $scheduled = now('Africa/Cairo')->addDays(3)->setTime(16, 0);
        $session = $this->postJson("{$this->base}/groups/{$target['id']}/sessions", [
            'kind' => 'single', 'revision' => $target['revision'], 'start_at' => $scheduled->format('Y-m-d\TH:i'),
            'plan_lecture_number' => 1, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('sessions.0');
        $this->postJson("{$this->base}/groups/{$target['id']}/start", ['revision' => $target['revision'] + 1])->assertOk();
        $makeupPath = "{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/makeup";
        $this->postJson("{$makeupPath}/book", [
            'session_id' => $session['id'], 'attempt_revision' => $attempt['revision'],
            'session_revision' => $session['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->travelTo($scheduled->copy()->addDay());
        $this->postJson("{$this->base}/students/{$student['id']}/enrollments/{$attempt['id']}/withdraw", [
            'withdrawn_on' => now('Africa/Cairo')->toDateString(), 'reason' => 'انسحاب بعد التعويض',
            'revision' => $attempt['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $this->getJson($makeupPath)->assertOk()
            ->assertJsonPath('sessions.0.can_book', false)
            ->assertJsonPath('sessions.0.can_prove', true);
        $attendance = "{$this->base}/groups/{$target['id']}/sessions/{$session['id']}/attendance";
        $this->assertContains($attempt['id'], array_column($this->getJson($attendance)
            ->assertOk()->json('students'), 'attempt_id'));
        $this->postJson("{$this->base}/groups/{$target['id']}/sessions/{$session['id']}/close", [
            'revision' => $session['revision'], 'request_id' => (string) Str::uuid(),
        ])->assertOk();
        $current = $this->getJson("{$this->base}/students/{$student['id']}/enrollments")
            ->assertOk()->json('attempts.0');
        $this->postJson("{$makeupPath}/prove", [
            'session_id' => $session['id'], 'attempt_revision' => $current['revision'],
            'session_revision' => 2, 'reason' => 'إثبات محاضرة قبل تاريخ الانسحاب',
            'request_id' => (string) Str::uuid(),
        ])->assertCreated();
        $this->center->run(function () use ($attempt, $session): void {
            $this->assertSame('counted', DB::table('study_attendance_entries')
                ->where('attempt_id', $attempt['id'])->where('session_id', $session['id'])->value('status'));
        });
    }

    private function group(int $branchId, string $name, int $lectureCount = 3): array
    {
        $course = $this->postJson("{$this->base}/courses", [
            'branch_id' => $branchId, 'name' => $name, 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('course');
        $stage = $this->postJson("{$this->base}/courses/{$course['id']}/stages", [
            'name' => 'Stage', 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('stage');
        $level = $this->postJson("{$this->base}/stages/{$stage['id']}/levels", [
            'name' => 'Level', 'request_id' => (string) Str::uuid(),
            'lectures' => array_map(fn ($number) => ['number' => $number, 'content' => "Lecture {$number}", 'planned_hours' => 1], range(1, $lectureCount)),
        ])->assertCreated()->json('level');
        $instructor = $this->postJson("{$this->base}/instructors", [
            'name' => "Teacher {$name}", 'branch_ids' => [$branchId], 'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('instructor');

        return $this->postJson("{$this->base}/groups", [
            'level_id' => $level['id'], 'plan_version_id' => $level['plan']['id'], 'name' => "Group {$name}",
            'approved_price' => '100.00', 'instructor_ids' => [$instructor['id']],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('group');
    }

    private function grant(array $roles): void
    {
        $this->asUser($this->owner);
        $this->putJson("{$this->base}/members/{$this->membership->id}/grants", [
            'center_roles' => [], 'branch_roles' => $roles,
        ])->assertOk();
    }

    private function student(): array
    {
        return $this->postJson("{$this->base}/students", [
            'name' => 'Student '.Str::random(8), 'branch_ids' => [$this->north],
            'request_id' => (string) Str::uuid(),
        ])->assertCreated()->json('student');
    }

    private function enroll(string $studentId, array $group, string $joinedOn): void
    {
        $url = "{$this->base}/students/{$studentId}/enrollments";
        $workspace = $this->getJson($url)->assertOk()->json();
        $this->postJson($url, [
            'group_id' => $group['id'], 'group_revision' => $group['revision'],
            'currency_revision' => $workspace['student']['currency_revision'],
            'joined_on' => $joinedOn, 'discount' => '0.00', 'discount_reason' => null,
            'version' => $workspace['student']['version'], 'request_id' => (string) Str::uuid(),
        ])->assertCreated();
    }

    private function asUser(User $user): void
    {
        $this->actingAs($user, 'web')->withSession(['center_id' => $this->center->id]);
    }
}
