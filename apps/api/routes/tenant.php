<?php

use App\Http\Controllers\CenterAuditController;
use App\Http\Controllers\CenterAuthController;
use App\Http\Controllers\CenterBranchController;
use App\Http\Controllers\CenterCurriculumController;
use App\Http\Controllers\CenterInstructorController;
use App\Http\Controllers\CenterMemberController;
use App\Http\Controllers\CenterSecurityController;
use App\Http\Controllers\CenterSettingsController;
use App\Http\Controllers\CenterStudentAllocationController;
use App\Http\Controllers\CenterStudentAttachmentController;
use App\Http\Controllers\CenterStudentController;
use App\Http\Controllers\CenterStudentCustomFieldController;
use App\Http\Controllers\CenterStudentEventNoteController;
use App\Http\Controllers\CenterStudentFinanceController;
use App\Http\Controllers\CenterStudentNumberingController;
use App\Http\Controllers\CenterStudentPhotoController;
use App\Http\Controllers\CenterStudentProfileChoiceController;
use App\Http\Controllers\CenterStudentSearchController;
use App\Http\Controllers\CenterStudentStatusController;
use App\Http\Controllers\CenterStudyAttendanceController;
use App\Http\Controllers\CenterStudyCoverageController;
use App\Http\Controllers\CenterStudyEnrollmentController;
use App\Http\Controllers\CenterStudyGroupController;
use App\Http\Controllers\CenterStudySessionController;
use App\Http\Middleware\MeasureCenterQueries;
use App\Http\Middleware\RequireCenterMember;
use App\Http\Middleware\ResolveCenter;
use App\Models\Branch;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Route;

Route::middleware(['web', MeasureCenterQueries::class, ResolveCenter::class])->prefix('api/v1/center')->group(function (): void {
    Route::get('invitations/{token}', [CenterAuthController::class, 'invitation'])->middleware('throttle:center-route');
    Route::post('invitations/{token}', [CenterAuthController::class, 'acceptInvitation'])->middleware('throttle:center-route');
    Route::post('auth/login', [CenterAuthController::class, 'login'])->middleware('throttle:center-route');
    Route::post('auth/mfa/challenge', [CenterAuthController::class, 'mfaChallenge'])->middleware('throttle:center-route');
    Route::post('auth/logout', [CenterAuthController::class, 'logout']);
    Route::post('auth/forgot-password', [CenterAuthController::class, 'forgotPassword'])->middleware('throttle:center-route');
    Route::post('auth/reset-password', [CenterAuthController::class, 'resetPassword'])->middleware('throttle:center-route');
    Route::middleware(RequireCenterMember::class)->group(function (): void {
        Route::get('user', function (Request $request) {
            $permissions = $request->attributes->get('center_permissions');
            $branches = Branch::query()->orderBy('name');

            if (! $permissions->isCenterManager()) {
                $branches->whereIn('id', array_keys($permissions->branchRoles));
            }

            $payload = [
                'user' => [
                    ...$request->user()->only(['id', 'name', 'email']),
                    'permissions' => $permissions->toArray(),
                    'mfa_enabled' => (bool) $request->user()->getAppAuthenticationSecret(),
                    'mfa_required_for_platform' => in_array($request->user()->platform_role, ['platform_owner', 'platform_support'], true),
                ],
                'membership' => $request->attributes->get('center_membership')->only(['status', 'grants_version']),
                'permissions' => $permissions->toArray(),
                'center' => $request->attributes->get('center')->only(['id', 'name', 'slug']),
                'branches' => $branches->get(['id', 'name', 'slug', 'address']),
            ];

            if ($request->query('include') === 'settings' && $permissions->isCenterManager()) {
                $payload['settings'] = DB::connection('tenant')->table('center_settings')->where('id', 1)
                    ->first(['contact_email', 'phone', 'address', 'student_number_start', 'student_number_revision', 'student_code_enabled', 'student_code_label', 'student_code_revision']) ?: [
                        'contact_email' => null, 'phone' => null, 'address' => null, 'student_number_start' => 1, 'student_number_revision' => 1,
                    ];
            }

            if ($request->query('include') === 'audit') {
                $payload['audit_entries'] = CenterAuditController::visibleEntries($request);
            }

            return response()->json($payload)->header('Cache-Control', 'private, no-store');
        });

        Route::get('branches', [CenterBranchController::class, 'index']);
        Route::get('student-custom-fields', [CenterStudentCustomFieldController::class, 'workspace']);
        Route::get('student-custom-fields/{fieldId}', [CenterStudentCustomFieldController::class, 'show']);
        Route::post('student-custom-fields', [CenterStudentCustomFieldController::class, 'store']);
        Route::patch('student-custom-fields/{fieldId}', [CenterStudentCustomFieldController::class, 'update']);
        Route::get('student-profile-choices', [CenterStudentProfileChoiceController::class, 'workspace']);
        Route::get('student-profile-choices/{choiceId}', [CenterStudentProfileChoiceController::class, 'show']);
        Route::post('student-profile-choices', [CenterStudentProfileChoiceController::class, 'store']);
        Route::patch('student-profile-choices/{choiceId}', [CenterStudentProfileChoiceController::class, 'update']);
        Route::get('student-workspace', [CenterStudentController::class, 'workspace']);
        Route::get('students/{studentId}/account', [CenterStudentFinanceController::class, 'account']);
        Route::get('students/{studentId}/enrollments', [CenterStudyEnrollmentController::class, 'workspace']);
        Route::post('students/{studentId}/enrollments', [CenterStudyEnrollmentController::class, 'store']);
        Route::get('students/{studentId}/enrollment-notes', [CenterStudentEventNoteController::class, 'index']);
        Route::get('students/{studentId}/enrollments/{attemptId}/note', [CenterStudentEventNoteController::class, 'show']);
        Route::put('students/{studentId}/enrollments/{attemptId}/note', [CenterStudentEventNoteController::class, 'save']);
        Route::post('students/{studentId}/payments', [CenterStudentFinanceController::class, 'recordPayment']);
        Route::get('students/{studentId}/payments/{paymentId}/allocation-options', [CenterStudentAllocationController::class, 'options']);
        Route::post('students/{studentId}/payments/{paymentId}/allocations', [CenterStudentAllocationController::class, 'allocate']);
        Route::post('students/{studentId}/allocations/{allocationId}/reverse', [CenterStudentAllocationController::class, 'reverse']);
        Route::patch('financial-currency', [CenterStudentFinanceController::class, 'updateCurrency']);
        Route::get('student-search-workspace', [CenterStudentSearchController::class, 'workspace']);
        Route::patch('student-search-policy', [CenterStudentSearchController::class, 'updatePolicy']);
        Route::get('students/similar', [CenterStudentController::class, 'similar']);
        Route::post('students/identity-preview', [CenterStudentController::class, 'identityPreview']);
        Route::get('students/submissions/{requestId}', [CenterStudentController::class, 'submission']);
        Route::get('students/{studentId}/barcode', [CenterStudentController::class, 'barcode']);
        Route::post('students/{studentId}/photo', [CenterStudentPhotoController::class, 'store']);
        Route::get('students/{studentId}/photo/{photoId}', [CenterStudentPhotoController::class, 'show']);
        Route::post('students/{studentId}/attachments', [CenterStudentAttachmentController::class, 'store']);
        Route::get('students/{studentId}/attachments/{attachmentId}/versions', [CenterStudentAttachmentController::class, 'versions']);
        Route::get('students/{studentId}/attachments/{attachmentId}/versions/{versionId}/preview', [CenterStudentAttachmentController::class, 'previewVersion']);
        Route::get('students/{studentId}/attachments/{attachmentId}/versions/{versionId}/download', [CenterStudentAttachmentController::class, 'downloadVersion']);
        Route::post('students/{studentId}/attachments/{attachmentId}/replace', [CenterStudentAttachmentController::class, 'replace']);
        Route::patch('students/{studentId}/attachments/{attachmentId}/classification', [CenterStudentAttachmentController::class, 'classify']);
        Route::post('students/{studentId}/attachments/{attachmentId}/archive', [CenterStudentAttachmentController::class, 'archive']);
        Route::post('students/{studentId}/attachments/{attachmentId}/restore', [CenterStudentAttachmentController::class, 'restore']);
        Route::get('students/{studentId}/attachments/{attachmentId}/preview', [CenterStudentAttachmentController::class, 'preview']);
        Route::get('students/{studentId}/attachments/{attachmentId}/download', [CenterStudentAttachmentController::class, 'download']);
        Route::get('students/{studentId}', [CenterStudentController::class, 'workspace']);
        Route::post('students/{studentId}/status', [CenterStudentStatusController::class, 'store']);
        Route::post('students', [CenterStudentController::class, 'store']);
        Route::patch('students/{studentId}/sharing', [CenterStudentController::class, 'updateSharing']);
        Route::patch('students/{studentId}', [CenterStudentController::class, 'update']);
        Route::get('instructor-workspace', [CenterInstructorController::class, 'workspace']);
        Route::get('instructors/submissions/{requestId}', [CenterInstructorController::class, 'submission']);
        Route::get('instructors/{instructorId}', [CenterInstructorController::class, 'workspace']);
        Route::post('instructors', [CenterInstructorController::class, 'store']);
        Route::patch('instructors/{instructorId}', [CenterInstructorController::class, 'update']);
        Route::get('curriculum-workspace', [CenterCurriculumController::class, 'workspace']);
        Route::get('curriculum/submissions/{requestId}', [CenterCurriculumController::class, 'submission']);
        Route::get('levels/{levelId}', [CenterCurriculumController::class, 'workspace']);
        Route::post('courses', [CenterCurriculumController::class, 'storeCourse']);
        Route::post('courses/{courseId}/stages', [CenterCurriculumController::class, 'storeStage']);
        Route::post('stages/{stageId}/levels', [CenterCurriculumController::class, 'storeLevel']);
        Route::patch('levels/{levelId}/first-plan', [CenterCurriculumController::class, 'updatePlan']);
        Route::patch('courses/{courseId}/completion-threshold', [CenterCurriculumController::class, 'updateCourseThreshold']);
        Route::patch('stages/{stageId}/completion-threshold', [CenterCurriculumController::class, 'updateStageThreshold']);
        Route::patch('levels/{levelId}/completion-threshold', [CenterCurriculumController::class, 'updateLevelThreshold']);
        Route::get('group-workspace', [CenterStudyGroupController::class, 'workspace']);
        Route::get('group-instructor-options', [CenterStudyGroupController::class, 'instructorOptions']);
        Route::get('groups/{groupId}', [CenterStudyGroupController::class, 'workspace']);
        Route::post('groups', [CenterStudyGroupController::class, 'store']);
        Route::post('groups/{groupId}/start', [CenterStudyGroupController::class, 'start']);
        Route::patch('groups/{groupId}/settings', [CenterStudyGroupController::class, 'updateSettings']);
        Route::get('groups/{groupId}/sessions', [CenterStudySessionController::class, 'workspace']);
        Route::get('groups/{groupId}/coverage', [CenterStudyCoverageController::class, 'workspace']);
        Route::post('groups/{groupId}/sessions/preview', [CenterStudySessionController::class, 'preview']);
        Route::post('groups/{groupId}/sessions', [CenterStudySessionController::class, 'store']);
        Route::patch('groups/{groupId}/sessions/{sessionId}/postpone', [CenterStudySessionController::class, 'postpone']);
        Route::get('groups/{groupId}/sessions/{sessionId}/attendance', [CenterStudyAttendanceController::class, 'workspace']);
        Route::post('groups/{groupId}/sessions/{sessionId}/attendance', [CenterStudyAttendanceController::class, 'record']);
        Route::post('groups/{groupId}/sessions/{sessionId}/attendance/{entryId}/undo', [CenterStudyAttendanceController::class, 'undo']);
        Route::post('groups/{groupId}/sessions/{sessionId}/close', [CenterStudyAttendanceController::class, 'close']);
        Route::post('branches', [CenterBranchController::class, 'store']);
        Route::get('branches/{branchId}', [CenterBranchController::class, 'show']);
        Route::patch('branches/{branchId}', [CenterBranchController::class, 'update']);
        Route::get('branches/{branchId}/audit', [CenterBranchController::class, 'auditLog']);
        Route::get('members', [CenterMemberController::class, 'index']);
        Route::get('member-workspace', [CenterMemberController::class, 'workspace']);
        Route::post('members/invitations', [CenterMemberController::class, 'invite']);
        Route::patch('members/{membership}/status', [CenterMemberController::class, 'updateStatus']);
        Route::put('members/{membership}/grants', [CenterMemberController::class, 'updateGrants']);
        Route::get('settings', [CenterSettingsController::class, 'show']);
        Route::patch('student-code-settings', [CenterStudentController::class, 'updateCodeSettings']);
        Route::patch('student-numbering', [CenterStudentNumberingController::class, 'update']);
        Route::patch('settings', [CenterSettingsController::class, 'update']);
        Route::get('audit', [CenterAuditController::class, 'index']);
        Route::post('security/mfa/setup', [CenterSecurityController::class, 'setup'])->middleware('throttle:center-route');
        Route::post('security/mfa/confirm', [CenterSecurityController::class, 'confirm'])->middleware('throttle:center-route');
        Route::post('security/mfa/cancel', [CenterSecurityController::class, 'cancel'])->middleware('throttle:center-route');
        Route::post('security/mfa/disable', [CenterSecurityController::class, 'disable'])->middleware('throttle:center-route');
    });
});
