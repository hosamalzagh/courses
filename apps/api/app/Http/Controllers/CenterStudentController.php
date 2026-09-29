<?php

namespace App\Http\Controllers;

use App\Support\ActiveStudentAllocations;
use App\Support\CenterPermissions;
use App\Support\CenterWrites;
use App\Support\EffectiveStudyFees;
use App\Support\StudentAttachments;
use App\Support\StudentBarcode;
use App\Support\StudentContacts;
use App\Support\StudentCustomFields;
use App\Support\StudentEventNotes;
use App\Support\StudentIdentity;
use App\Support\StudentManualCodes;
use App\Support\StudentMoney;
use App\Support\StudentPhotos;
use App\Support\StudentProfileChoices;
use Carbon\CarbonImmutable;
use Closure;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use stdClass;

class CenterStudentController extends Controller
{
    private const GENERAL_FIELDS = ['date_of_birth', 'gender', 'address', 'email', 'school', 'employer', 'specialization', 'city_id', 'qualification_id', 'profession_id', 'collection_method_id', 'discovery_source_id'];

    public function workspace(Request $request, ?string $studentId = null): JsonResponse
    {
        $data = $request->validate([
            'page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'status_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'branches_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'tab' => ['sometimes', 'in:custom-history,attachments,enrollment-notes,notes,study,attendance'],
            'study_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'study_q' => ['sometimes', 'string', 'max:100'],
            'attendance_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'attendance_q' => ['sometimes', 'string', 'max:100'],
            'custom_history_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'attachments_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'notes_page' => ['sometimes', 'integer', 'min:1', 'max:100000'],
            'attachments_status' => ['sometimes', 'in:active,archived'],
            'q' => ['nullable', 'string', 'max:255'],
            'identifier' => ['nullable', 'string', 'max:50'],
        ]);
        $permissions = $request->attributes->get('center_permissions');
        $page = (int) ($data['page'] ?? 1);
        $branchPage = (int) ($data['branches_page'] ?? 1);
        $branches = DB::connection('tenant')->table('branches')->orderBy('id');
        if (! $permissions->isCenterManager()) {
            $branches->whereIn('id', $this->branchScope($permissions, 'read'));
        }
        $branchRows = $branches->offset(($branchPage - 1) * 50)->limit(51)->select(['id', 'name', 'slug', 'address']);
        $workspace = DB::connection('tenant')->query()
            ->selectSub(DB::connection('tenant')->query()->fromSub($branchRows, 'branch_rows')->selectRaw('json_agg(branch_rows)'), 'branches')
            ->selectSub(StudentProfileChoices::initialQuery(), 'choices')
            ->selectSub(StudentCustomFields::initialQuery($permissions, $studentId), 'custom_fields')
            ->selectSub(DB::connection('tenant')->table('center_settings')->where('id', 1)->select('student_custom_fields_revision'), 'custom_fields_revision')
            ->selectSub(DB::connection('tenant')->table('center_settings')->where('id', 1)->selectRaw("json_build_object('enabled', student_code_enabled, 'label', student_code_label, 'revision', student_code_revision)"), 'code_settings')
            ->selectSub(DB::connection('tenant')->table('student_search_policy')->where('id', 1)->select('enabled'), 'student_search_enabled')->first();
        $branches = collect(json_decode($workspace->branches ?? '[]'));
        $choiceRows = collect(json_decode($workspace->choices ?? '[]', true));
        $choices = [];
        foreach (StudentProfileChoices::KINDS as $kind) {
            $rows = $choiceRows->where('kind', $kind)->values();
            $choices[$kind] = ['choices' => $rows->take(50)->values(), 'page' => 1, 'has_more' => $rows->count() > 50];
        }
        $query = $this->visibleStudents($permissions, false, $studentId !== null);
        if ($studentId !== null) {
            abort_unless(Str::isUuid($studentId), 404);
            $query->where('students.id', $studentId);
        }
        if (isset($data['q']) && trim($data['q']) !== '') {
            $search = $this->normalizeName($data['q']);
            $phone = $this->normalizePhone($data['q']);
            $query->where(function (Builder $rows) use ($search, $phone, $data): void {
                $rows->whereRaw('strpos(name_search, ?) > 0', [$search]);
                if ($phone !== null) {
                    StudentContacts::matchPhone($rows, $phone);
                }
                if (ctype_digit($data['q']) && strlen($data['q']) <= 18) {
                    $rows->orWhere('student_number', $data['q']);
                }
            });
        }
        if (isset($data['identifier']) && trim($data['identifier']) !== '') {
            $query->whereIn('students.id', StudentManualCodes::identifiers(trim($data['identifier'])));
        }

        if ($studentId !== null) {
            $statusPage = (int) ($data['status_page'] ?? 1);
            $history = DB::connection('tenant')->table('student_suspensions')->where('student_id', $studentId)
                ->orderByDesc('suspended_at')->orderByDesc('id')->offset(($statusPage - 1) * 20)->limit(21)
                ->select(['id', 'suspended_by', 'suspended_by_name', 'suspended_reason', 'suspended_at', 'lifted_by', 'lifted_by_name', 'lifted_reason', 'lifted_at']);
            $query->selectSub(DB::connection('tenant')->query()->fromSub($history, 'periods')->selectRaw('json_agg(periods)'), 'suspensions');
            $important = StudentEventNotes::visible($permissions)
                ->whereColumn('notes.student_id', 'students.id')->where('notes.important', true)
                ->orderByDesc('notes.updated_at')->orderByDesc('notes.id')->limit(3);
            $important->select(['notes.id', 'notes.event_type', 'notes.event_id', 'notes.branch_id',
                'notes.important', 'notes.revision', 'notes.updated_by_name', 'notes.updated_at',
                'attendance.session_id', 'attendance_group.id as group_id'])
                ->selectRaw('left(notes.body, 120) as body')
                ->selectRaw('COALESCE(payment.id, allocation.payment_id) as payment_id');
            $query->selectSub(DB::connection('tenant')->query()->fromSub($important, 'important_rows')
                ->selectRaw('json_agg(important_rows)'), 'important_notes');
            $currentStudy = DB::connection('tenant')->table('study_attempts as summary_attempts')
                ->join('levels as summary_levels', 'summary_levels.id', '=', 'summary_attempts.level_id')
                ->join('stages as summary_stages', 'summary_stages.id', '=', 'summary_levels.stage_id')
                ->join('courses as summary_courses', 'summary_courses.id', '=', 'summary_stages.course_id')
                ->join('branches as summary_branches', 'summary_branches.id', '=', 'summary_attempts.branch_id')
                ->leftJoin('study_groups as summary_groups', function ($join): void {
                    $join->on('summary_groups.id', '=', 'summary_attempts.current_group_id')
                        ->on('summary_groups.level_id', '=', 'summary_attempts.level_id');
                })
                ->whereColumn('summary_attempts.student_id', 'students.id')
                ->where('summary_attempts.status', 'active')
                ->whereColumn('summary_courses.branch_id', 'summary_attempts.branch_id')
                ->whereExists(DB::connection('tenant')->table('student_branches as summary_associations')
                    ->whereColumn('summary_associations.student_id', 'students.id')
                    ->whereColumn('summary_associations.branch_id', 'summary_attempts.branch_id')->selectRaw('1'))
                ->when(! $permissions->isCenterManager(), fn (Builder $rows) => $rows->whereIn('summary_attempts.branch_id', $this->branchScope($permissions, 'read')))
                ->orderByDesc('summary_attempts.updated_at')->orderByDesc('summary_attempts.id')->limit(4)
                ->select(['summary_attempts.id', 'summary_attempts.branch_id', 'summary_attempts.updated_at',
                    'summary_branches.name as branch_name', 'summary_courses.name as course_name',
                    'summary_levels.name as level_name', 'summary_groups.name as group_name']);
            $query->selectSub(DB::connection('tenant')->query()->fromSub($currentStudy, 'study_summary_rows')
                ->selectRaw('json_agg(study_summary_rows ORDER BY updated_at DESC, id DESC)'), 'current_study_summary');
            $absences = DB::connection('tenant')->table('study_attendance_entries as summary_attendance')
                ->join('study_sessions as summary_sessions', 'summary_sessions.id', '=', 'summary_attendance.session_id')
                ->join('study_attempts as summary_attempts', 'summary_attempts.id', '=', 'summary_attendance.attempt_id')
                ->join('study_attempt_group_periods as summary_periods', 'summary_periods.attempt_id', '=', 'summary_attempts.id')
                ->join('study_groups as summary_groups', 'summary_groups.id', '=', 'summary_sessions.group_id')
                ->join('levels as summary_levels', 'summary_levels.id', '=', 'summary_groups.level_id')
                ->join('stages as summary_stages', 'summary_stages.id', '=', 'summary_levels.stage_id')
                ->join('courses as summary_courses', 'summary_courses.id', '=', 'summary_stages.course_id')
                ->whereColumn('summary_attempts.student_id', 'students.id')
                ->whereColumn('summary_sessions.group_id', 'summary_attempts.current_group_id')
                ->whereColumn('summary_periods.group_id', 'summary_sessions.group_id')
                ->whereNull('summary_periods.left_on')
                ->whereRaw("(summary_sessions.scheduled_at AT TIME ZONE 'Africa/Cairo')::date >= summary_periods.joined_on")
                ->whereColumn('summary_courses.branch_id', 'summary_attempts.branch_id')
                ->where('summary_attempts.status', 'active')
                ->where('summary_attendance.status', 'absent')
                ->where('summary_sessions.status', '!=', 'cancelled')
                ->whereExists(DB::connection('tenant')->table('student_branches as attendance_associations')
                    ->whereColumn('attendance_associations.student_id', 'students.id')
                    ->whereColumn('attendance_associations.branch_id', 'summary_courses.branch_id')->selectRaw('1'))
                ->when(! $permissions->isCenterManager(), fn (Builder $rows) => $rows->whereIn('summary_courses.branch_id', $this->branchScope($permissions, 'read')))
                ->selectRaw('COUNT(*)');
            $query->selectSub($absences, 'current_group_absences');
            $financeBranches = $this->branchScope($permissions, 'finance.read');
            if ($permissions->isCenterManager() || $financeBranches !== []) {
                $due = DB::connection('tenant')->table('study_attempt_fees as summary_fees')
                    ->whereColumn('summary_fees.student_id', 'students.id')
                    ->when(! $permissions->isCenterManager(), fn (Builder $rows) => $rows->whereIn('summary_fees.branch_id', $financeBranches))
                    ->selectRaw('COALESCE(SUM('.EffectiveStudyFees::amount('summary_fees').'), 0)');
                $paid = ActiveStudentAllocations::query()->whereColumn('allocations.student_id', 'students.id')
                    ->when(! $permissions->isCenterManager(), fn (Builder $rows) => $rows->whereIn('allocations.target_branch_id', $financeBranches))
                    ->selectRaw('COALESCE(SUM(allocations.amount), 0)');
                $query->selectSub($due, 'summary_due_total')->selectSub($paid, 'summary_paid_total')
                    ->selectSub(DB::connection('tenant')->table('center_settings')->where('id', 1)
                        ->select('financial_currency'), 'summary_currency');
            }
        }
        if ($studentId !== null && ($data['tab'] ?? '') === 'custom-history') {
            $historyPage = (int) ($data['custom_history_page'] ?? 1);
            $history = StudentCustomFields::historyQuery($historyPage, $permissions)->whereColumn('history.student_id', 'students.id');
            $query->selectSub(DB::connection('tenant')->query()->fromSub($history, 'history_rows')->selectRaw('json_agg(history_rows ORDER BY id DESC)'), 'custom_history');
        }
        if ($studentId !== null && ($data['tab'] ?? '') === 'attachments') {
            $attachmentPage = (int) ($data['attachments_page'] ?? 1);
            $attachmentStatus = $permissions->isCenterManager() ? ($data['attachments_status'] ?? 'active') : 'active';
            $attachments = DB::connection('tenant')->table('student_attachments')
                ->whereColumn('student_attachments.student_id', 'students.id')
                ->when($attachmentStatus === 'archived', fn (Builder $rows) => $rows->whereNotNull('archived_at'), fn (Builder $rows) => $rows->whereNull('archived_at'))
                ->when(! $permissions->isCenterManager(), function (Builder $rows) use ($permissions): void {
                    $rows->where(function (Builder $visible) use ($permissions): void {
                        $visible->where(fn (Builder $general) => $general->where('classification', 'general')->where('content_classification', 'general'))->orWhereExists(DB::connection('tenant')->table('student_branches')
                            ->whereColumn('student_branches.student_id', 'students.id')
                            ->whereIn('student_branches.branch_id', StudentIdentity::readableBranches($permissions))->selectRaw('1'));
                    });
                })
                ->orderByDesc('created_at')->orderByDesc('id')
                ->offset(($attachmentPage - 1) * 20)->limit(21)
                ->select(['id', 'student_id', 'title', 'classification', 'mime', 'size_bytes', 'current_version', 'archived_at', 'created_at']);
            $query->selectSub(DB::connection('tenant')->query()->fromSub($attachments, 'attachment_rows')->selectRaw('json_agg(attachment_rows ORDER BY created_at DESC, id DESC)'), 'attachments');
        }
        if ($studentId !== null && ($data['tab'] ?? '') === 'enrollment-notes') {
            $notesPage = (int) ($data['notes_page'] ?? 1);
            $notes = DB::connection('tenant')->table('student_event_notes as notes')
                ->join('study_attempts as attempts', 'attempts.id', '=', 'notes.event_id')
                ->join('study_attempt_fees as fees', 'fees.attempt_id', '=', 'attempts.id')
                ->join('study_attempt_group_periods as periods', function ($join): void {
                    $join->on('periods.attempt_id', '=', 'attempts.id')
                        ->whereRaw('periods.id = (SELECT first_period.id FROM study_attempt_group_periods AS first_period WHERE first_period.attempt_id = attempts.id ORDER BY first_period.created_at, first_period.id LIMIT 1)');
                })
                ->join('study_groups as groups', 'groups.id', '=', 'periods.group_id')
                ->whereColumn('notes.student_id', 'students.id')->whereColumn('attempts.student_id', 'students.id')
                ->where('notes.event_type', 'study_attempt')->whereColumn('notes.branch_id', 'fees.branch_id')
                ->when(! $permissions->isCenterManager(), fn (Builder $rows) => $rows->whereIn('fees.branch_id', $this->branchScope($permissions, 'read')))
                ->orderByDesc('notes.updated_at')->orderByDesc('notes.id')
                ->offset(($notesPage - 1) * 20)->limit(21)
                ->select(['notes.event_id as attempt_id', 'notes.branch_id', 'notes.body', 'notes.important', 'notes.revision',
                    'notes.updated_by_name', 'notes.updated_at', 'groups.name as group_name']);
            $query->selectSub(DB::connection('tenant')->query()->fromSub($notes, 'note_rows')->selectRaw('json_agg(note_rows ORDER BY updated_at DESC, attempt_id DESC)'), 'enrollment_notes');
        }
        if ($studentId !== null && ($data['tab'] ?? '') === 'notes') {
            $notesPage = (int) ($data['notes_page'] ?? 1);
            $notes = StudentEventNotes::visible($permissions)
                ->whereColumn('notes.student_id', 'students.id')
                ->orderByDesc('notes.updated_at')->orderByDesc('notes.id')
                ->offset(($notesPage - 1) * 20)->limit(21);
            $query->selectSub(DB::connection('tenant')->query()->fromSub($notes, 'note_rows')
                ->selectRaw('json_agg(note_rows)'), 'student_notes');
        }
        if ($studentId !== null && ($data['tab'] ?? '') === 'study') {
            $studyPage = (int) ($data['study_page'] ?? 1);
            $studySearch = trim($data['study_q'] ?? '');
            $readableBranches = $permissions->isCenterManager() ? null : $this->branchScope($permissions, 'read');
            $currentPeriod = '(SELECT current_period.id FROM study_attempt_group_periods AS current_period WHERE current_period.attempt_id = attempts.id AND current_period.group_id = attempts.current_group_id ORDER BY (current_period.left_on IS NULL) DESC, (NOT EXISTS (SELECT 1 FROM study_attempt_waitlists AS prior_waitlists WHERE prior_waitlists.origin_period_id = current_period.id)) DESC, current_period.joined_on DESC, current_period.created_at DESC, current_period.id DESC LIMIT 1)';
            $legacyOrigin = static fn (string $alias): string => "(SELECT legacy_period.id FROM study_attempt_group_periods AS legacy_period WHERE legacy_period.attempt_id = {$alias}.attempt_id AND legacy_period.group_id = {$alias}.from_group_id AND legacy_period.left_on = {$alias}.entered_on AND legacy_period.created_at <= {$alias}.created_at ORDER BY legacy_period.created_at DESC, legacy_period.id DESC LIMIT 1)";
            $legacyWaitlistOrigin = $legacyOrigin('study_attempt_waitlists');
            $latestWaitlistId = '(SELECT latest_waitlist.id FROM study_attempt_waitlists AS latest_waitlist WHERE latest_waitlist.attempt_id = attempts.id ORDER BY latest_waitlist.entry_revision DESC NULLS LAST, (latest_waitlist.left_on IS NULL) DESC, latest_waitlist.entered_on DESC, latest_waitlist.created_at DESC, latest_waitlist.id DESC LIMIT 1)';
            $waitlistOriginPeriod = '(SELECT COALESCE(study_waitlists.origin_period_id, CASE WHEN attempts.current_group_id IS NULL THEN '.$legacyOrigin('study_waitlists').' END) FROM study_attempt_waitlists AS study_waitlists WHERE study_waitlists.id = '.$latestWaitlistId.')';
            $terminalPeriod = "(periods.id = {$currentPeriod} OR (attempts.status IN ('active', 'withdrawn') AND attempts.current_group_id IS NULL AND periods.id = {$waitlistOriginPeriod}))";
            $attempts = DB::connection('tenant')->table('study_attempt_group_periods as periods')
                ->join('study_attempts as attempts', 'attempts.id', '=', 'periods.attempt_id')
                ->join('study_groups as period_groups', 'period_groups.id', '=', 'periods.group_id')
                ->join('levels as study_levels', 'study_levels.id', '=', 'period_groups.level_id')
                ->join('stages as study_stages', 'study_stages.id', '=', 'study_levels.stage_id')
                ->join('courses as study_courses', 'study_courses.id', '=', 'study_stages.course_id')
                ->join('branches as study_branches', 'study_branches.id', '=', 'study_courses.branch_id')
                ->leftJoin('study_attempt_withdrawals as withdrawals', 'withdrawals.attempt_id', '=', 'attempts.id')
                ->leftJoin('study_attempt_completion_decisions as decisions', 'decisions.attempt_id', '=', 'attempts.id')
                ->whereColumn('attempts.student_id', 'students.id')
                ->whereExists(DB::connection('tenant')->table('student_branches as study_associations')
                    ->whereColumn('study_associations.student_id', 'attempts.student_id')
                    ->whereColumn('study_associations.branch_id', 'study_courses.branch_id')->selectRaw('1'))
                ->when($readableBranches !== null, fn (Builder $rows) => $rows->whereIn('study_courses.branch_id', $readableBranches))
                ->when($studySearch !== '', fn (Builder $rows) => $rows->where(function (Builder $matched) use ($studySearch): void {
                    $term = '%'.addcslashes($studySearch, '%_\\').'%';
                    $matched->where('study_courses.name', 'ILIKE', $term)
                        ->orWhere('study_levels.name', 'ILIKE', $term)
                        ->orWhere('study_branches.name', 'ILIKE', $term)
                        ->orWhere('period_groups.name', 'ILIKE', $term);
                }))
                ->orderByDesc('periods.joined_on')->orderByDesc('periods.id')
                ->offset(($studyPage - 1) * 20)->limit(21)
                ->select(['attempts.id', 'periods.id as period_id', 'study_courses.branch_id',
                    'periods.joined_on', 'periods.left_on', 'periods.created_at', 'study_levels.name as level_name',
                    'study_courses.id as course_id', 'study_courses.name as course_name',
                    'study_branches.name as branch_name'])
                ->selectRaw("CASE WHEN {$terminalPeriod} THEN attempts.status ELSE 'transferred' END AS status")
                ->selectRaw("CASE WHEN attempts.status = 'active' AND periods.id = {$currentPeriod} AND study_courses.branch_id = attempts.branch_id THEN period_groups.name END AS current_group_name")
                ->selectRaw("CASE WHEN attempts.status <> 'active' OR periods.id IS DISTINCT FROM {$currentPeriod} OR study_courses.branch_id <> attempts.branch_id THEN period_groups.name END AS previous_group_name")
                ->selectRaw("CASE WHEN attempts.status = 'withdrawn' AND {$terminalPeriod} AND study_courses.branch_id = attempts.branch_id THEN withdrawals.withdrawn_on END AS withdrawn_on")
                ->selectRaw("CASE WHEN attempts.status = 'completed' AND periods.id = {$currentPeriod} AND study_courses.branch_id = attempts.branch_id THEN decisions.approved_at END AS approved_at")
                ->selectRaw("CASE WHEN attempts.status = 'completed' AND periods.id = {$currentPeriod} AND study_courses.branch_id = attempts.branch_id THEN decisions.exceptional END AS exceptional")
                ->selectRaw("
                    (SELECT row_to_json(waitlist) FROM (
                        SELECT entered_on, left_on, reason, (origin_period_id IS NULL) AS origin_uncertain FROM study_attempt_waitlists
                        WHERE attempt_id = attempts.id AND branch_id = study_courses.branch_id
                            AND periods.id = COALESCE(study_attempt_waitlists.origin_period_id,
                                CASE WHEN attempts.current_group_id IS NULL AND study_attempt_waitlists.id = {$latestWaitlistId}
                                THEN {$legacyWaitlistOrigin} END)
                        ORDER BY entry_revision DESC NULLS LAST, entered_on DESC, created_at DESC, id DESC LIMIT 1
                    ) AS waitlist) AS latest_waitlist")
                ->selectRaw('(SELECT max(transferred_on) FROM study_attempt_transfers WHERE attempt_id = attempts.id AND (from_branch_id = study_courses.branch_id OR to_branch_id = study_courses.branch_id)) AS last_visible_transfer_on');
            $query->selectSub(DB::connection('tenant')->query()->fromSub($attempts, 'study_rows')
                ->selectRaw('json_agg(study_rows ORDER BY joined_on DESC, period_id DESC)'), 'study_attempts');
        }
        if ($studentId !== null && ($data['tab'] ?? '') === 'attendance') {
            $attendancePage = (int) ($data['attendance_page'] ?? 1);
            $attendanceSearch = trim($data['attendance_q'] ?? '');
            $readableSource = 'EXISTS (SELECT 1 FROM student_branches AS source_associations WHERE source_associations.student_id = students.id AND source_associations.branch_id = source_courses.branch_id)';
            if (! $permissions->isCenterManager()) {
                $readableSource .= ' AND source_courses.branch_id IN ('.(implode(',', array_map('intval', $this->branchScope($permissions, 'read'))) ?: 'NULL').')';
            }
            $attendance = DB::connection('tenant')->table('study_attendance_entries as entries')
                ->join('study_attempts as attempts', 'attempts.id', '=', 'entries.attempt_id')
                ->join('study_sessions as sessions', 'sessions.id', '=', 'entries.session_id')
                ->join('study_groups as groups', 'groups.id', '=', 'sessions.group_id')
                ->join('levels', 'levels.id', '=', 'groups.level_id')
                ->join('stages', 'stages.id', '=', 'levels.stage_id')
                ->join('courses', 'courses.id', '=', 'stages.course_id')
                ->join('branches', 'branches.id', '=', 'courses.branch_id')
                ->leftJoin('study_makeup_bookings as bookings', function ($join): void {
                    $join->on('bookings.attempt_id', '=', 'entries.attempt_id')
                        ->on('bookings.session_id', '=', 'entries.session_id');
                })
                ->leftJoin('study_sessions as source_sessions', 'source_sessions.id', '=', 'bookings.source_session_id')
                ->leftJoin('study_groups as source_groups', 'source_groups.id', '=', 'source_sessions.group_id')
                ->leftJoin('levels as source_levels', 'source_levels.id', '=', 'source_groups.level_id')
                ->leftJoin('stages as source_stages', 'source_stages.id', '=', 'source_levels.stage_id')
                ->leftJoin('courses as source_courses', 'source_courses.id', '=', 'source_stages.course_id')
                ->whereColumn('attempts.student_id', 'students.id')
                ->when(! $permissions->isCenterManager(), fn (Builder $rows) => $rows->whereIn('courses.branch_id', $this->branchScope($permissions, 'read')))
                ->when($attendanceSearch !== '', function (Builder $rows) use ($attendanceSearch): void {
                    $term = '%'.addcslashes($attendanceSearch, '%_\\').'%';
                    $rows->where(function (Builder $matches) use ($term): void {
                        $matches->where('courses.name', 'ILIKE', $term)
                            ->orWhere('groups.name', 'ILIKE', $term)
                            ->orWhere('branches.name', 'ILIKE', $term)
                            ->orWhere('sessions.title', 'ILIKE', $term)
                            ->orWhereRaw('sessions.number::text ILIKE ?', [$term]);
                    });
                })
                ->where(function (Builder $rows): void {
                    $rows->whereNotNull('entries.status')->orWhereExists(DB::connection('tenant')->table('student_suspensions as attendance_suspensions')
                        ->whereColumn('attendance_suspensions.student_id', 'attempts.student_id')
                        ->whereColumn('attendance_suspensions.suspended_at', '<=', 'sessions.scheduled_at')
                        ->where(fn (Builder $period) => $period->whereNull('attendance_suspensions.lifted_at')
                            ->orWhereColumn('attendance_suspensions.lifted_at', '>', 'sessions.scheduled_at'))->selectRaw('1'));
                })
                ->orderByDesc('sessions.scheduled_at')->orderByDesc('entries.id')
                ->offset(($attendancePage - 1) * 20)->limit(21)
                ->select(['entries.id', 'entries.status', 'entries.revision', 'entries.recorded_at',
                    'attempts.id as attempt_id', 'sessions.id as session_id', 'sessions.scheduled_at',
                    'sessions.number as session_number', 'sessions.title as session_title',
                    'sessions.status as session_status',
                    'groups.id as group_id', 'groups.name as group_name', 'courses.branch_id',
                    'branches.name as branch_name', 'courses.name as course_name',
                    'bookings.id as booking_id'])
                ->selectRaw("CASE WHEN {$readableSource} THEN bookings.source_session_id END AS source_session_id, CASE WHEN {$readableSource} THEN source_groups.id END AS source_group_id")
                ->selectRaw("CASE WHEN entries.status IS NULL THEN 'suspended' WHEN bookings.id IS NOT NULL THEN 'makeup' ELSE 'primary' END AS kind");
            $query->selectSub(DB::connection('tenant')->query()->fromSub($attendance, 'attendance_rows')
                ->selectRaw('json_agg(attendance_rows ORDER BY scheduled_at DESC, id DESC)'), 'attendance_entries');
        }
        $students = $query->orderBy('student_number')->offset(($page - 1) * 50)->limit(51)->get();
        if ($studentId !== null) {
            abort_if($students->isEmpty(), 404);
        }

        return response()->json([
            'user' => $request->user()->only(['id', 'name', 'email']),
            'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
            'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
            'permissions' => $permissions->toArray(),
            'branches' => $branches->take(50)->values(),
            'profile_choice_lists' => $choices,
            'student_code_settings' => json_decode($workspace->code_settings, true),
            'student_search_enabled' => (bool) $workspace->student_search_enabled,
            'custom_fields' => ['fields' => array_slice(json_decode($workspace->custom_fields ?? '[]', true) ?? [], 0, 50), 'revision' => (int) $workspace->custom_fields_revision, 'page' => 1, 'has_more' => count(json_decode($workspace->custom_fields ?? '[]', true) ?? []) > 50],
            'students' => $students->take(50)->map(fn (stdClass $student): array => $this->payload($student, $permissions))->values(),
            ...($studentId !== null ? ['suspensions' => array_slice(json_decode($students->first()->suspensions ?? '[]', true) ?? [], 0, 20), 'status_pagination' => ['page' => $statusPage, 'has_more' => count(json_decode($students->first()->suspensions ?? '[]', true) ?? []) > 20]] : []),
            ...(isset($historyPage) ? ['custom_history' => ['entries' => array_slice(json_decode($students->first()->custom_history ?? '[]', true) ?? [], 0, 50), 'pagination' => ['page' => $historyPage, 'has_more' => count(json_decode($students->first()->custom_history ?? '[]', true) ?? []) > 50]]] : []),
            ...(isset($attachmentPage) ? ['attachments' => ['entries' => collect(json_decode($students->first()->attachments ?? '[]') ?? [])->take(20)->map(fn (stdClass $row): array => StudentAttachments::payload($row))->values(), 'status' => $attachmentStatus, 'pagination' => ['page' => $attachmentPage, 'has_more' => count(json_decode($students->first()->attachments ?? '[]', true) ?? []) > 20]]] : []),
            ...(($data['tab'] ?? '') === 'enrollment-notes' ? ['enrollment_notes' => ['entries' => array_slice(json_decode($students->first()->enrollment_notes ?? '[]', true) ?? [], 0, 20),
                'pagination' => ['page' => $notesPage, 'has_more' => count(json_decode($students->first()->enrollment_notes ?? '[]', true) ?? []) > 20]]] : []),
            ...($studentId !== null ? ['important_notes' => json_decode($students->first()->important_notes ?? '[]', true) ?? []] : []),
            ...($studentId !== null ? ['summary' => [
                'current_study' => array_slice(json_decode($students->first()->current_study_summary ?? '[]', true) ?? [], 0, 3),
                'current_study_has_more' => count(json_decode($students->first()->current_study_summary ?? '[]', true) ?? []) > 3,
                'current_group_absences' => (int) $students->first()->current_group_absences,
                'financial' => isset($students->first()->summary_due_total)
                    ? ['debt' => StudentMoney::format(max(0, StudentMoney::cents($students->first()->summary_due_total)
                        - StudentMoney::cents($students->first()->summary_paid_total))), 'currency' => $students->first()->summary_currency]
                    : null,
            ]] : []),
            ...($studentId !== null && ($data['tab'] ?? '') === 'notes' ? ['student_notes' => ['entries' => array_slice(json_decode($students->first()->student_notes ?? '[]', true) ?? [], 0, 20),
                'pagination' => ['page' => $notesPage, 'has_more' => count(json_decode($students->first()->student_notes ?? '[]', true) ?? []) > 20]]] : []),
            ...($studentId !== null && ($data['tab'] ?? '') === 'study' ? ['study' => ['attempts' => array_slice(json_decode($students->first()->study_attempts ?? '[]', true) ?? [], 0, 20),
                'pagination' => ['page' => $studyPage, 'has_more' => count(json_decode($students->first()->study_attempts ?? '[]', true) ?? []) > 20]]] : []),
            ...($studentId !== null && ($data['tab'] ?? '') === 'attendance' ? ['attendance' => ['entries' => array_slice(json_decode($students->first()->attendance_entries ?? '[]', true) ?? [], 0, 20),
                'pagination' => ['page' => $attendancePage, 'has_more' => count(json_decode($students->first()->attendance_entries ?? '[]', true) ?? []) > 20]]] : []),
            'pagination' => ['page' => $page, 'has_more' => $students->count() > 50, 'branches_page' => $branchPage, 'branches_has_more' => $branches->count() > 50],
        ])->header('Cache-Control', 'private, no-store');
    }

    public function similar(Request $request): JsonResponse
    {
        $data = $request->validate(['name' => ['nullable', 'string', 'max:255'], 'phone' => ['nullable', 'string', 'max:50'], 'exclude' => ['nullable', 'uuid'], 'phones' => ['sometimes', 'array', 'max:25'], 'phones.*' => ['string', 'max:50']]);
        $permissions = $request->attributes->get('center_permissions');
        $query = $this->visibleStudents($permissions, true);
        $name = $this->normalizeName($data['name'] ?? '');
        $phones = StudentContacts::normalizePhones([...($data['phones'] ?? []), $data['phone'] ?? null]);
        if ($name === '' && $phones === []) {
            return response()->json(['students' => []])->header('Cache-Control', 'private, no-store');
        }
        $query->where(function (Builder $query) use ($name, $phones): void {
            if ($name !== '') {
                $query->where('name_search', $name);
            }
            foreach ($phones as $phone) {
                StudentContacts::matchPhone($query, $phone, true);
            }
        })->when(! empty($data['exclude']), fn (Builder $query) => $query->where('students.id', '!=', $data['exclude']));

        return response()->json(['students' => $query->orderBy('student_number')->limit(10)->get()
            ->map(fn (stdClass $student): array => $student->branch_ids === null
                ? ['id' => $student->id, 'student_number' => $student->student_number, 'name' => $student->name, 'phone' => $student->phone, 'within_scope' => false]
                : [...$this->payload($student, $permissions), 'within_scope' => true])])
            ->header('Cache-Control', 'private, no-store');
    }

    public function submission(Request $request, string $requestId): JsonResponse
    {
        abort_unless(Str::isUuid($requestId), 404);
        $permissions = $request->attributes->get('center_permissions');
        $student = $this->visibleStudents($permissions, false, true)->where('request_id', $requestId)
            ->where('created_by', $request->user()->id)->first();
        abort_unless($student, 404);

        return response()->json(['student' => $this->payload($student, $permissions)])
            ->header('Cache-Control', 'private, no-store');
    }

    public function barcode(Request $request, string $studentId): Response
    {
        abort_unless(Str::isUuid($studentId), 404);
        $student = $this->visibleStudents($request->attributes->get('center_permissions'))->where('students.id', $studentId)->first();
        abort_unless($student, 404);
        $number = (int) $student->student_number;
        $svg = StudentBarcode::svg($number);

        return response('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>طباعة الباركود الأساسي</title><style>body{margin:24px;text-align:center;font-family:system-ui;color:#000;background:#fff}svg{display:block;margin:24px auto 8px;max-width:100%;height:auto}p{font-size:20px;font-family:monospace}button{padding:12px 24px;font:inherit}@media print{button{display:none}body{margin:0}}</style><body>'.$svg.'<p dir="ltr">'.$number.'</p><button onclick="window.print()">طباعة الباركود</button></body></html>')
            ->header('Cache-Control', 'private, no-store')
            ->header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'")
            ->header('X-Content-Type-Options', 'nosniff');
    }

    public function store(Request $request): JsonResponse
    {
        $data = $this->validateProfile($request);
        $request->validate(['request_id' => ['required', 'uuid']]);

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $data): JsonResponse {
            $this->authorizeBranches($permissions, $data['branch_ids']);
            StudentIdentity::authorize($data, $permissions, $data['branch_ids']);
            StudentCustomFields::authorize($data, $permissions, $data['branch_ids']);
            $hash = hash('sha256', json_encode($data));
            $existing = DB::connection('tenant')->table('students')->where('request_id', $request->input('request_id'))->first();
            if ($existing) {
                abort_unless($existing->created_by === $request->user()->id, 403);
                if ($existing->request_hash !== $hash) {
                    $this->conflict('student_request_changed');
                }

                return response()->json(['student' => $this->read($existing->id, $permissions)]);
            }
            StudentManualCodes::validate($data['manual_code'] ?? null);
            $identity = StudentIdentity::columns($data, $permissions, $data['branch_ids']);
            StudentProfileChoices::validate($data);
            $customValues = StudentCustomFields::validate($data, StudentIdentity::canManage($permissions, $data['branch_ids']));
            $start = DB::connection('tenant')->table('center_settings')->where('id', 1)->value('student_number_start');
            $sequence = DB::connection('tenant')->selectOne('SELECT last_value, is_called FROM students_student_number_seq');
            $next = (int) $sequence->last_value + ($sequence->is_called ? 1 : 0);
            if (max($next, (int) $start) > 9007199254740991) {
                throw new HttpResponseException(response()->json(['code' => 'student_numbering_exhausted', 'message' => 'وصل ترقيم الطلاب إلى الحد المدعوم. تواصل مع مسؤول المركز.'], 409));
            }
            StudentManualCodes::validateAllocation(max($next, (int) $start));
            if ((int) $start > $next) {
                DB::connection('tenant')->selectOne("SELECT setval('students_student_number_seq', ?, false)", [(int) $start]);
            }
            $id = (string) Str::uuid();
            DB::connection('tenant')->table('students')->insert([
                ...array_intersect_key($data, array_flip(self::GENERAL_FIELDS)),
                ...$identity,
                ...StudentContacts::columns($data),
                'id' => $id, 'name' => $data['name'], 'phone' => $data['phone'], 'manual_code' => $data['manual_code'] ?? null, 'manual_code_number' => StudentManualCodes::number($data['manual_code'] ?? null),
                'sharing_enabled' => (bool) DB::connection('tenant')->table('student_search_policy')->where('id', 1)->value('default_sharing_enabled'),
                'name_search' => $this->normalizeName($data['name']), 'phone_search' => $this->normalizePhone($data['phone']),
                'request_id' => $request->input('request_id'), 'request_hash' => $hash, 'created_by' => $request->user()->id,
                'created_at' => now(), 'updated_at' => now(),
            ]);
            StudentCustomFields::save($id, array_filter($customValues, fn ($value) => $value !== null), $request, 1);
            $this->associate($id, $data['branch_ids']);
            $student = $this->read($id, $permissions);
            $this->audit($request, 'student.created', $student, null, $data['branch_ids'], [], array_keys(array_filter($customValues, fn ($value) => $value !== null)));

            return response()->json(['student' => $student], 201);
        });
    }

    public function update(Request $request, string $studentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId), 404);
        $data = $this->validateProfile($request);
        $request->validate(['revision' => ['required', 'integer', 'min:1']]);

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $data, $studentId): JsonResponse {
            $row = DB::connection('tenant')->table('students')->where('id', $studentId)->lockForUpdate()->first();
            abort_unless($row, 404);
            $before = $this->read($studentId, $permissions);
            abort_unless($before['can_manage'], 403);
            $this->authorizeBranches($permissions, $data['branch_ids']);
            // Omitted legacy phone preserves it. Old callers echoing the summary cannot assign an owner.
            if (! $request->exists('phone') || (! isset($data['contacts']) && $before['contacts'] !== [] && $data['phone'] === $before['phone'])) {
                $data['phone'] = $row->phone;
            } elseif (! isset($data['contacts']) && $before['contacts'] !== [] && $data['phone'] !== $row->phone) {
                throw ValidationException::withMessages(['contacts' => 'عدّل الرقم من جهات التواصل وقنواته.']);
            }
            $currentBranches = DB::connection('tenant')->table('student_branches')->where('student_id', $studentId)->pluck('branch_id')->all();
            StudentIdentity::authorize($data, $permissions, $currentBranches);
            StudentCustomFields::authorize($data, $permissions, $currentBranches);
            $identity = array_intersect_key($data, array_flip(StudentIdentity::FIELDS));
            $identityChanged = collect($identity)->contains(fn ($value, $field): bool => $row->{$field} !== $value);
            $added = array_diff($data['branch_ids'], $currentBranches);
            $general = array_intersect_key($data, array_flip(self::GENERAL_FIELDS));
            $contactChanged = isset($data['contacts']) && ($before['contacts'] != $data['contacts'] || $before['channels'] != $data['channels']);
            $manualCode = $data['manual_code'] ?? (array_key_exists('manual_code', $data) ? null : $row->manual_code);
            $manualChanged = $row->manual_code !== $manualCode;
            $storedCustom = DB::connection('tenant')->table('student_custom_field_values')->where('student_id', $studentId)->pluck('value', 'field_id')->map(fn ($value) => json_decode($value, true))->all();
            $customChanged = collect($data['custom_values'] ?? [])->contains(fn ($value, $field) => ($storedCustom[$field] ?? null) !== $value);
            $generalChanged = collect($general)->contains(fn ($value, $field): bool => $row->{$field} !== $value);
            if (($identityChanged || $manualChanged || $contactChanged || $generalChanged || $customChanged || $row->name !== $data['name'] || $row->phone !== $data['phone'] || $added !== []) && $row->revision !== (int) $request->input('revision')) {
                $this->conflict('student_changed');
            }
            $customValues = StudentCustomFields::validate($data, StudentIdentity::canManage($permissions, $currentBranches), $studentId);
            if (! $customChanged && ! $identityChanged && ! $manualChanged && ! $contactChanged && ! $generalChanged && $row->name === $data['name'] && $row->phone === $data['phone'] && $added === []) {
                return response()->json(['student' => $before]);
            }
            $identity = StudentIdentity::columns($data, $permissions, $currentBranches, $row);
            if ($manualChanged) {
                StudentManualCodes::validate($manualCode, $studentId);
            }
            StudentProfileChoices::validate($data, $row);
            DB::connection('tenant')->table('students')->where('id', $studentId)->update([
                ...$general,
                ...$identity,
                ...StudentContacts::columns($data),
                'name' => $data['name'], 'phone' => $data['phone'], 'manual_code' => $manualCode, 'manual_code_number' => StudentManualCodes::number($manualCode),
                'name_search' => $this->normalizeName($data['name']), 'phone_search' => $this->normalizePhone($data['phone']),
                'revision' => $row->revision + 1, 'updated_at' => now(),
            ]);
            $changedCustomValues = array_filter($customValues, fn ($value, $id) => ($storedCustom[$id] ?? null) !== $value, ARRAY_FILTER_USE_BOTH);
            StudentCustomFields::save($studentId, $changedCustomValues, $request, $row->revision + 1);
            $this->associate($studentId, $added);
            $student = $this->read($studentId, $permissions);
            $this->audit($request, 'student.updated', $student, $before, array_unique([...$currentBranches, ...$added]), $currentBranches, array_keys($changedCustomValues));

            return response()->json(['student' => $student]);
        });
    }

    public function updateSharing(Request $request, string $studentId): JsonResponse
    {
        abort_unless(Str::isUuid($studentId), 404);
        $data = $request->validate(['sharing_enabled' => ['required', 'boolean'], 'revision' => ['required', 'integer', 'min:1']]);

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $data, $studentId): JsonResponse {
            $row = DB::connection('tenant')->table('students')->where('id', $studentId)->lockForUpdate()->first();
            abort_unless($row, 404);
            $before = $this->read($studentId, $permissions);
            abort_unless($before['can_manage'], 403);
            $sharing = (bool) $data['sharing_enabled'];
            if ((bool) $row->sharing_enabled === $sharing) {
                return response()->json(['student' => $before]);
            }
            if ($row->revision !== (int) $data['revision']) {
                $this->conflict('student_changed');
            }
            DB::connection('tenant')->table('students')->where('id', $studentId)->update([
                'sharing_enabled' => $sharing, 'revision' => $row->revision + 1, 'updated_at' => now(),
            ]);
            $branches = DB::connection('tenant')->table('student_branches')->where('student_id', $studentId)->pluck('branch_id');
            foreach ($branches as $branchId) {
                DB::connection('tenant')->table('center_audit_logs')->insert([
                    'actor_id' => $request->user()->id, 'branch_id' => $branchId, 'event' => 'student.sharing_changed',
                    'details' => json_encode(['student_id' => $studentId, 'before' => ['sharing_enabled' => (bool) $row->sharing_enabled], 'after' => ['sharing_enabled' => $sharing]]),
                    'created_at' => now(),
                ]);
            }

            return response()->json(['student' => $this->read($studentId, $permissions)]);
        });
    }

    public function identityPreview(Request $request): JsonResponse
    {
        $data = $request->validate(['national_id' => ['required', 'string', 'max:14'], 'student_id' => ['nullable', 'uuid'], 'branch_ids' => ['present', 'array', 'max:50'], 'branch_ids.*' => ['integer', 'distinct'], 'date_of_birth' => ['nullable', 'date_format:Y-m-d']], ['national_id.*' => 'أدخل الرقم القومي كنص من 14 رقمًا.', 'date_of_birth.*' => 'أدخل تاريخ ميلاد صحيحًا بصيغة YYYY-MM-DD.']);

        return $this->write($request, function (CenterPermissions $permissions) use ($data): JsonResponse {
            $savedBirth = null;
            if (isset($data['student_id'])) {
                $student = $this->read($data['student_id'], $permissions);
                abort_unless($student['can_manage_identity'], 403);
                $savedBirth = $student['date_of_birth'];
            } else {
                $this->authorizeBranches($permissions, $data['branch_ids']);
                abort_unless(StudentIdentity::canManage($permissions, $data['branch_ids']), 403);
            }
            $birth = StudentIdentity::birthDate(trim($data['national_id']));
            $entered = $data['date_of_birth'] ?? null;

            return response()->json(['date_of_birth' => $birth, 'saved_date_of_birth' => $savedBirth, 'conflict' => ($entered !== null && $entered !== $birth) || ($savedBirth !== null && $savedBirth !== $birth)])
                ->header('Cache-Control', 'private, no-store');
        });
    }

    public function updateCodeSettings(Request $request): JsonResponse
    {
        $data = $request->validate(['enabled' => ['required', 'boolean'], 'label' => ['required', 'string', 'max:100'], 'revision' => ['required', 'integer', 'min:1']], ['label.*' => 'أدخل اسم الباركود الإضافي (حتى 100 حرف).']);

        return $this->write($request, function (CenterPermissions $permissions) use ($request, $data): JsonResponse {
            abort_unless($permissions->isCenterManager(), 403);
            $settings = DB::connection('tenant')->table('center_settings')->where('id', 1)->lockForUpdate()->first();
            $value = ['student_code_enabled' => (bool) $data['enabled'], 'student_code_label' => trim($data['label'])];
            if ((bool) $settings->student_code_enabled !== $value['student_code_enabled'] || $settings->student_code_label !== $value['student_code_label']) {
                if ($settings->student_code_revision !== (int) $data['revision']) {
                    $this->conflict('student_code_settings_changed');
                }
                DB::connection('tenant')->table('center_settings')->where('id', 1)->update([...$value, 'student_code_revision' => $settings->student_code_revision + 1, 'updated_at' => now()]);
                DB::connection('tenant')->table('center_audit_logs')->insert(['actor_id' => $request->user()->id, 'event' => 'center.student_code_settings_changed', 'details' => json_encode(['before' => ['enabled' => (bool) $settings->student_code_enabled, 'label' => $settings->student_code_label], 'after' => ['enabled' => $value['student_code_enabled'], 'label' => $value['student_code_label']]]), 'created_at' => now()]);
            }

            return (new CenterSettingsController)->show($request);
        });
    }

    private function write(Request $request, Closure $operation): JsonResponse
    {
        return CenterWrites::run($request, $operation);
    }

    private function validateProfile(Request $request): array
    {
        $data = $request->validate([
            'custom_values' => ['sometimes', 'array', 'max:10000'],
            'custom_fields_revision' => ['sometimes', 'integer', 'min:1'],
            'national_id' => ['sometimes', 'nullable', 'string', 'max:14'],
            'passport_number' => ['sometimes', 'nullable', 'string', 'max:50'],
            'manual_code' => ['sometimes', 'nullable', 'string', 'max:50'],
            'name' => ['required', 'string', 'max:255'], 'phone' => ['nullable', 'string', 'max:50'],
            'branch_ids' => ['present', 'array', $request->isMethod('POST') ? 'min:1' : 'min:0', 'max:50'], 'branch_ids.*' => ['integer', 'distinct'],
            'status' => ['prohibited'], 'status_revision' => ['prohibited'],
            'student_number' => ['prohibited'], 'user_id' => ['prohibited'],
            'date_of_birth' => ['sometimes', 'nullable', 'date_format:Y-m-d', 'after_or_equal:0001-01-01', 'before_or_equal:today'],
            'gender' => ['sometimes', 'nullable', 'in:male,female'],
            'address' => ['sometimes', 'nullable', 'string', 'max:1000'],
            'email' => ['sometimes', 'nullable', 'email', 'max:255'],
            'school' => ['sometimes', 'nullable', 'string', 'max:255'],
            'employer' => ['sometimes', 'nullable', 'string', 'max:255'],
            ...array_fill_keys(StudentProfileChoices::fields(), ['sometimes', 'nullable', 'uuid']),
            'specialization' => ['sometimes', 'nullable', 'string', 'max:255'],
            ...StudentContacts::rules(),
        ], ['name.required' => 'أدخل اسم الطالب.', 'branch_ids.required' => 'اختر فرعًا مصرحًا به على الأقل.',
            'date_of_birth.*' => 'أدخل تاريخ ميلاد صحيحًا بصيغة YYYY-MM-DD لا يتجاوز اليوم.',
            'manual_code.*' => 'أدخل الباركود الإضافي كنص، حتى 50 حرفًا، مع الاحتفاظ بالأصفار والأحرف.',
            'national_id.*' => 'أدخل الرقم القومي كنص من 14 رقمًا.', 'passport_number.*' => 'أدخل رقم الجواز كنص، حتى 50 حرفًا.',
            'email.*' => 'أدخل بريدًا إلكترونيًا صحيحًا.', 'gender.*' => 'اختر ذكر أو أنثى.',
            'contacts.*.name.*' => 'أدخل اسم جهة التواصل (حتى 255 حرفًا).',
            'contacts.*.relationship.*' => 'أدخل صلة الجهة بالطالب (حتى 100 حرف).',
            'contacts.*.phone.*' => 'أدخل هاتف جهة التواصل كنص يحتوي أرقامًا (حتى 50 حرفًا).',
            'contacts.*.id.*' => 'جهة التواصل غير صالحة أو مكررة.',
            'contacts.*.primary.*' => 'حدد الجهة الأساسية.',
            'contacts.*' => 'أدخل قائمة جهات تواصل صحيحة، بحد أقصى 20 جهة.',
            'channels.*.phone.*' => 'أدخل رقم القناة كنص يحتوي أرقامًا (حتى 50 حرفًا).',
            'channels.*.contact_id.*' => 'اختر صاحب القناة من جهات هذا الطالب.',
            'channels.*' => 'حدد قنوات التواصل وأصحابها بصورة صحيحة.']);
        if (isset($data['custom_values'])) {
            $data['custom_values'] = array_map(fn ($value) => is_string($value) ? (trim($value) === '' ? null : trim($value)) : $value, $data['custom_values']);
            ksort($data['custom_values']);
        }
        if (array_key_exists('manual_code', $data)) {
            $data['manual_code'] = is_string($data['manual_code']) ? (trim($data['manual_code']) === '' ? null : trim($data['manual_code'])) : null;
        }
        foreach (StudentIdentity::FIELDS as $field) {
            if (array_key_exists($field, $data) && is_string($data[$field])) {
                $data[$field] = trim($data[$field]) === '' ? null : trim($data[$field]);
            }
        }
        $data['name'] = trim($data['name']);
        abort_if($data['name'] === '', 422, 'أدخل اسم الطالب.');
        $data['phone'] = isset($data['phone']) ? trim($data['phone']) : null;
        foreach (self::GENERAL_FIELDS as $field) {
            if (array_key_exists($field, $data) && is_string($data[$field])) {
                $data[$field] = trim($data[$field]) ?: null;
            }
        }
        $data['branch_ids'] = array_map('intval', $data['branch_ids']);
        sort($data['branch_ids']);

        return StudentContacts::normalize($data);
    }

    private function authorizeBranches(CenterPermissions $permissions, array $branchIds): void
    {
        foreach ($branchIds as $branchId) {
            abort_unless($permissions->can('students.manage', $branchId), 403);
        }
        abort_unless(DB::connection('tenant')->table('branches')->whereIn('id', $branchIds)->count() === count($branchIds), 403);
    }

    private function branchScope(CenterPermissions $permissions, string $action): array
    {
        return array_keys(array_filter($permissions->branchRoles, fn (array $roles): bool => in_array($action, CenterPermissions::actions($roles), true)));
    }

    private function visibleStudents(CenterPermissions $permissions, bool $includeCenterSearch = false, bool $includeProfileDetails = false): Builder
    {
        $associations = DB::connection('tenant')->table('student_branches')->whereColumn('student_id', 'students.id');
        if (! $permissions->isCenterManager()) {
            $associations->whereIn('branch_id', $this->branchScope($permissions, 'read'));
        }

        $identityBranches = array_intersect($this->branchScope($permissions, 'read'), $this->branchScope($permissions, 'students.identity'));
        $identityScope = $permissions->isCenterManager() ? 'true' : 'EXISTS (SELECT 1 FROM student_branches identity_branches WHERE identity_branches.student_id = students.id AND identity_branches.branch_id IN ('.(implode(',', array_map('intval', $identityBranches)) ?: 'NULL').'))';

        return DB::connection('tenant')->table('students')
            ->when($includeProfileDetails, fn (Builder $query) => $query->selectRaw("CASE WHEN {$identityScope} THEN json_build_object('national_id', national_id, 'passport_number', passport_number) ELSE NULL END AS identity"))
            ->addSelect(['students.id', 'student_number', 'manual_code', 'name', 'students.phone as legacy_phone', 'contacts', 'channels', 'revision', 'created_by', 'created_at', 'sharing_enabled', 'status', 'status_revision', 'photo_revision', 'attachment_revision', ...self::GENERAL_FIELDS])
            ->selectRaw(StudentContacts::phoneSql().' as phone')
            ->selectSub(StudentProfileChoices::selectedQuery(), 'profile_choices')
            ->when($includeProfileDetails, fn (Builder $query) => $query->selectSub(StudentCustomFields::valuesQuery($permissions), 'custom_values')->selectSub(StudentPhotos::summaryQuery(), 'photo'))
            ->selectSub(StudentCustomFields::missingQuery(), 'missing_custom_fields')
            ->selectSub((clone $associations)->selectRaw('json_agg(branch_id ORDER BY branch_id)'), 'branch_ids')
            ->where(function (Builder $query) use ($associations, $permissions, $includeCenterSearch): void {
                $query->whereExists((clone $associations)->selectRaw('1'));
                if ($includeCenterSearch && CenterStudentSearchController::hasSearchPermission($permissions)) {
                    $query->orWhere(function (Builder $shared): void {
                        $shared->where('students.sharing_enabled', true)
                            ->whereExists(DB::connection('tenant')->table('student_search_policy')->where('id', 1)->where('enabled', true)->selectRaw('1'));
                    });
                }
            });
    }

    private function payload(stdClass $row, CenterPermissions $permissions): array
    {
        $branches = json_decode($row->branch_ids, true);

        return [...array_intersect_key((array) $row, array_flip(self::GENERAL_FIELDS)),
            ...(isset($row->identity) ? ['identity' => json_decode($row->identity, true)] : []),
            'can_read_identity' => StudentIdentity::canRead($permissions, $branches), 'can_manage_identity' => StudentIdentity::canManage($permissions, $branches),
            'contacts' => json_decode($row->contacts, true), 'channels' => json_decode($row->channels, true), 'legacy_phone' => $row->legacy_phone,
            'missing_custom_fields' => (int) $row->missing_custom_fields,
            ...(isset($row->custom_values) ? ['custom_values' => (object) (json_decode($row->custom_values, true) ?? [])] : []),
            'profile_choices' => json_decode($row->profile_choices ?? '{}', true) ?? [],
            'age' => $row->date_of_birth === null ? null : (int) CarbonImmutable::parse($row->date_of_birth)->diffInYears(CarbonImmutable::today()),
            'status' => $row->status, 'status_revision' => $row->status_revision, 'can_change_status' => $permissions->isCenterManager(),
            'created_by' => $row->created_by, 'created_at' => $row->created_at,
            'photo' => isset($row->photo) ? json_decode($row->photo, true) : null, 'photo_revision' => $row->photo_revision,
            'attachment_revision' => $row->attachment_revision,
            'manual_code' => $row->manual_code,
            'id' => $row->id, 'student_number' => $row->student_number, 'name' => $row->name, 'phone' => $row->phone,
            'revision' => $row->revision, 'branch_ids' => $branches, 'sharing_enabled' => (bool) $row->sharing_enabled,
            'can_manage' => collect($branches)->contains(fn (int $id): bool => $permissions->can('students.manage', $id))];
    }

    private function read(string $id, CenterPermissions $permissions): array
    {
        $row = $this->visibleStudents($permissions, false, true)->where('students.id', $id)->first();
        abort_unless($row, 404);

        return $this->payload($row, $permissions);
    }

    private function associate(string $id, array $branchIds): void
    {
        foreach ($branchIds as $branchId) {
            DB::connection('tenant')->table('student_branches')->insertOrIgnore(['student_id' => $id, 'branch_id' => $branchId, 'created_at' => now()]);
        }
    }

    private function audit(Request $request, string $event, array $after, ?array $before, array $branchIds, array $previousBranchIds = [], array $customChangedFields = []): void
    {
        $basic = fn (?array $student): ?array => $student === null ? null : array_intersect_key($student, array_flip(['student_number', 'manual_code', 'name', 'phone', 'legacy_phone', 'contacts', 'channels', 'profile_choices', ...self::GENERAL_FIELDS]));
        $identityChanged = array_values(array_filter(StudentIdentity::FIELDS, fn (string $field): bool => ($before['identity'][$field] ?? null) !== ($after['identity'][$field] ?? null)));
        foreach ($branchIds as $branchId) {
            DB::connection('tenant')->table('center_audit_logs')->insert([
                'actor_id' => $request->user()->id, 'branch_id' => $branchId, 'event' => $event,
                'details' => json_encode(['student_id' => $after['id'], 'before' => $basic($before), 'after' => $basic($after), 'identity_changed' => $identityChanged, 'custom_fields_changed' => $customChangedFields,
                    'associated_before' => in_array($branchId, $previousBranchIds, true), 'associated_after' => true]), 'created_at' => now(),
            ]);
        }
    }

    private function normalizeName(string $name): string
    {
        return mb_strtolower(preg_replace('/\s+/u', ' ', trim($name)));
    }

    private function normalizePhone(?string $phone): ?string
    {
        $value = preg_replace('/[^0-9]/', '', strtr($phone ?? '', array_combine(mb_str_split('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'), str_split('01234567890123456789'))));

        return $value === '' ? null : $value;
    }

    private function conflict(string $code): never
    {
        throw new HttpResponseException(response()->json(['code' => $code], 409));
    }
}
