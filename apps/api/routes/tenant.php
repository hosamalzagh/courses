<?php

use App\Http\Controllers\CenterAbsenceReviewController;
use App\Http\Controllers\CenterAttemptThresholdController;
use App\Http\Controllers\CenterAuditController;
use App\Http\Controllers\CenterAuthController;
use App\Http\Controllers\CenterBranchController;
use App\Http\Controllers\CenterContentEquivalenceController;
use App\Http\Controllers\CenterCourseCompletionController;
use App\Http\Controllers\CenterCurriculumController;
use App\Http\Controllers\CenterCurriculumCopyController;
use App\Http\Controllers\CenterCurriculumExplorerController;
use App\Http\Controllers\CenterGroupRequirementController;
use App\Http\Controllers\CenterGroupRequirementEquivalenceController;
use App\Http\Controllers\CenterInstructorController;
use App\Http\Controllers\CenterMemberController;
use App\Http\Controllers\CenterSecurityController;
use App\Http\Controllers\CenterSettingsController;
use App\Http\Controllers\CenterStudentAllocationController;
use App\Http\Controllers\CenterStudentAttachmentController;
use App\Http\Controllers\CenterStudentController;
use App\Http\Controllers\CenterStudentCustomFieldController;
use App\Http\Controllers\CenterStudentEventNoteController;
use App\Http\Controllers\CenterStudentFeeAdjustmentController;
use App\Http\Controllers\CenterStudentFinanceController;
use App\Http\Controllers\CenterStudentFinancialNoteController;
use App\Http\Controllers\CenterStudentNotesController;
use App\Http\Controllers\CenterStudentNumberingController;
use App\Http\Controllers\CenterStudentPaymentCorrectionController;
use App\Http\Controllers\CenterStudentPhotoController;
use App\Http\Controllers\CenterStudentProfileChoiceController;
use App\Http\Controllers\CenterStudentRefundController;
use App\Http\Controllers\CenterStudentSearchController;
use App\Http\Controllers\CenterStudentStatusController;
use App\Http\Controllers\CenterStudyAttendanceController;
use App\Http\Controllers\CenterStudyCompletionController;
use App\Http\Controllers\CenterStudyCoverageController;
use App\Http\Controllers\CenterStudyEnrollmentController;
use App\Http\Controllers\CenterStudyGroupController;
use App\Http\Controllers\CenterStudyMakeupController;
use App\Http\Controllers\CenterStudyPlanApplicationController;
use App\Http\Controllers\CenterStudySessionController;
use App\Http\Controllers\CenterStudyTeachingController;
use App\Http\Controllers\CenterStudyTransferController;
use App\Http\Controllers\CenterStudyWaitlistController;
use App\Http\Controllers\CenterWorkspaceController;
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
        Route::get('workspaces', [CenterWorkspaceController::class, 'index']);
        Route::post('workspaces', [CenterWorkspaceController::class, 'store']);
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
                    ->first(['contact_email', 'phone', 'address', 'student_number_start', 'student_number_revision', 'student_code_enabled', 'student_code_label', 'student_code_revision', 'student_all_branches_enabled', 'student_all_branches_revision', 'financial_currency', 'financial_currency_revision', 'financial_currency_locked_at']) ?: [
                        'contact_email' => null, 'phone' => null, 'address' => null, 'student_number_start' => 1, 'student_number_revision' => 1,
                        'student_all_branches_enabled' => false, 'student_all_branches_revision' => 1,
                        'financial_currency' => null, 'financial_currency_revision' => 1, 'financial_currency_locked_at' => null,
                    ];
            }

            if ($request->query('include') === 'student-settings' && $permissions->isCenterManager()) {
                $studentSettings = DB::connection('tenant')->table('center_settings as settings')
                    ->crossJoin('student_search_policy as policy')
                    ->where('settings.id', 1)->where('policy.id', 1)
                    ->first([
                        'settings.student_number_start', 'settings.student_number_revision', 'settings.student_code_enabled',
                        'settings.student_code_label', 'settings.student_code_revision', 'settings.student_all_branches_enabled', 'settings.student_all_branches_revision',
                        'policy.enabled as policy_enabled', 'policy.revision as policy_revision',
                        'policy.default_sharing_enabled as policy_default_sharing_enabled',
                    ]);
                $payload['settings'] = [
                    'student_number_start' => $studentSettings->student_number_start,
                    'student_number_revision' => $studentSettings->student_number_revision,
                    'student_code_enabled' => (bool) $studentSettings->student_code_enabled,
                    'student_code_label' => $studentSettings->student_code_label,
                    'student_code_revision' => $studentSettings->student_code_revision,
                    'student_all_branches_enabled' => (bool) $studentSettings->student_all_branches_enabled,
                    'student_all_branches_revision' => $studentSettings->student_all_branches_revision,
                ];
                $payload['student_search_policy'] = [
                    'enabled' => (bool) $studentSettings->policy_enabled,
                    'revision' => $studentSettings->policy_revision,
                    'default_sharing_enabled' => (bool) $studentSettings->policy_default_sharing_enabled,
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
        Route::get('students/{studentId}/fees/{feeId}/adjustments', [CenterStudentFeeAdjustmentController::class, 'show']);
        Route::post('students/{studentId}/fees/{feeId}/adjustments', [CenterStudentFeeAdjustmentController::class, 'store']);
        Route::get('students/{studentId}/enrollments', [CenterStudyEnrollmentController::class, 'workspace']);
        Route::get('students/{studentId}/courses/{courseId}/completion', [CenterCourseCompletionController::class, 'show']);
        Route::post('students/{studentId}/enrollments', [CenterStudyEnrollmentController::class, 'store']);
        Route::post('students/{studentId}/enrollments/{attemptId}/withdraw', [CenterStudyEnrollmentController::class, 'withdraw']);
        Route::get('students/{studentId}/enrollments/{attemptId}/waitlist', [CenterStudyWaitlistController::class, 'options']);
        Route::post('students/{studentId}/enrollments/{attemptId}/waitlist', [CenterStudyWaitlistController::class, 'enter']);
        Route::post('students/{studentId}/enrollments/{attemptId}/reattach', [CenterStudyWaitlistController::class, 'leave']);
        Route::get('students/{studentId}/enrollments/{attemptId}/transfer/preview', [CenterStudyTransferController::class, 'preview']);
        Route::get('students/{studentId}/enrollments/{attemptId}/transfer/history', [CenterStudyTransferController::class, 'history']);
        Route::post('students/{studentId}/enrollments/{attemptId}/transfer', [CenterStudyTransferController::class, 'store']);
        Route::get('students/{studentId}/enrollments/{attemptId}/makeup', [CenterStudyMakeupController::class, 'workspace']);
        Route::get('students/{studentId}/enrollments/{attemptId}/makeup/absences', [CenterStudyMakeupController::class, 'absences']);
        Route::post('students/{studentId}/enrollments/{attemptId}/makeup/book', [CenterStudyMakeupController::class, 'book']);
        Route::post('students/{studentId}/enrollments/{attemptId}/makeup/prove', [CenterStudyMakeupController::class, 'prove']);
        Route::get('students/{studentId}/enrollment-notes', [CenterStudentEventNoteController::class, 'index']);
        Route::get('students/{studentId}/notes', [CenterStudentNotesController::class, 'index']);
        Route::get('students/{studentId}/notes/{noteId}', [CenterStudentNotesController::class, 'show']);
        Route::get('students/{studentId}/enrollments/{attemptId}/note', [CenterStudentEventNoteController::class, 'show']);
        Route::put('students/{studentId}/enrollments/{attemptId}/note', [CenterStudentEventNoteController::class, 'save']);
        Route::post('students/{studentId}/payments', [CenterStudentFinanceController::class, 'recordPayment']);
        Route::get('students/{studentId}/payments/{eventId}/note', [CenterStudentFinancialNoteController::class, 'payment']);
        Route::put('students/{studentId}/payments/{eventId}/note', [CenterStudentFinancialNoteController::class, 'savePayment']);
        Route::get('students/{studentId}/allocations/{eventId}/note', [CenterStudentFinancialNoteController::class, 'allocation']);
        Route::put('students/{studentId}/allocations/{eventId}/note', [CenterStudentFinancialNoteController::class, 'saveAllocation']);
        Route::get('students/{studentId}/financial-events/{type}/{eventId}/note', [CenterStudentFinancialNoteController::class, 'financialEvent']);
        Route::put('students/{studentId}/financial-events/{type}/{eventId}/note', [CenterStudentFinancialNoteController::class, 'saveFinancialEvent']);
        Route::get('students/{studentId}/payments/{paymentId}/allocation-options', [CenterStudentAllocationController::class, 'options']);
        Route::post('students/{studentId}/payments/{paymentId}/allocations/preview', [CenterStudentAllocationController::class, 'preview']);
        Route::post('students/{studentId}/payments/{paymentId}/allocations', [CenterStudentAllocationController::class, 'allocate']);
        Route::get('students/{studentId}/payments/{paymentId}/corrections', [CenterStudentPaymentCorrectionController::class, 'index']);
        Route::post('students/{studentId}/payments/{paymentId}/corrections/preview', [CenterStudentPaymentCorrectionController::class, 'preview']);
        Route::post('students/{studentId}/payments/{paymentId}/corrections', [CenterStudentPaymentCorrectionController::class, 'correct']);
        Route::get('students/{studentId}/payments/{paymentId}/refunds', [CenterStudentRefundController::class, 'index']);
        Route::post('students/{studentId}/payments/{paymentId}/refunds/preview', [CenterStudentRefundController::class, 'preview']);
        Route::post('students/{studentId}/payments/{paymentId}/refunds', [CenterStudentRefundController::class, 'record']);
        Route::post('students/{studentId}/refunds/{refundId}/corrections/preview', [CenterStudentRefundController::class, 'correctionPreview']);
        Route::post('students/{studentId}/refunds/{refundId}/corrections', [CenterStudentRefundController::class, 'correct']);
        Route::post('students/{studentId}/allocations/{allocationId}/reverse', [CenterStudentAllocationController::class, 'reverse']);
        Route::post('students/{studentId}/allocations/{allocationId}/corrections/preview', [CenterStudentAllocationController::class, 'correctionPreview']);
        Route::post('students/{studentId}/allocations/{allocationId}/corrections', [CenterStudentAllocationController::class, 'correct']);
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
        Route::get('content-equivalences', [CenterContentEquivalenceController::class, 'workspace']);
        Route::post('content-equivalences', [CenterContentEquivalenceController::class, 'store']);
        Route::get('curriculum/submissions/{requestId}', [CenterCurriculumController::class, 'submission']);
        Route::get('levels/{levelId}', [CenterCurriculumController::class, 'workspace']);
        Route::post('courses', [CenterCurriculumController::class, 'storeCourse']);
        Route::delete('courses/{courseId}', [CenterCurriculumController::class, 'destroyCourse']);
        Route::delete('stages/{stageId}', [CenterCurriculumController::class, 'destroyStage']);
        Route::delete('levels/{levelId}', [CenterCurriculumController::class, 'destroyLevel']);
        Route::get('courses/{courseId}/copy-destinations', [CenterCurriculumCopyController::class, 'destinations']);
        Route::get('courses/{courseId}/copy-preview', [CenterCurriculumCopyController::class, 'preview']);
        Route::post('courses/{courseId}/copies', [CenterCurriculumCopyController::class, 'store']);
        Route::post('courses/{courseId}/stages', [CenterCurriculumController::class, 'storeStage']);
        Route::post('stages/{stageId}/levels', [CenterCurriculumController::class, 'storeLevel']);
        Route::patch('levels/{levelId}/first-plan', [CenterCurriculumController::class, 'updatePlan']);
        Route::post('levels/{levelId}/plan-versions', [CenterCurriculumController::class, 'storePlanVersion']);
        Route::patch('courses/{courseId}/completion-threshold', [CenterCurriculumController::class, 'updateCourseThreshold']);
        Route::patch('stages/{stageId}/completion-threshold', [CenterCurriculumController::class, 'updateStageThreshold']);
        Route::patch('levels/{levelId}/completion-threshold', [CenterCurriculumController::class, 'updateLevelThreshold']);
        Route::get('curriculum-explorer', [CenterCurriculumExplorerController::class, 'workspace']);
        Route::get('curriculum-explorer/children', [CenterCurriculumExplorerController::class, 'children']);
        Route::get('group-workspace', [CenterStudyGroupController::class, 'workspace']);
        Route::get('absence-review', [CenterAbsenceReviewController::class, 'workspace']);
        Route::post('absence-review/waitlist-batches', [CenterAbsenceReviewController::class, 'previewWaitlistBatch']);
        Route::get('absence-review/waitlist-batches/{batchId}', [CenterAbsenceReviewController::class, 'showWaitlistBatch']);
        Route::post('absence-review/waitlist-batches/{batchId}/execute', [CenterAbsenceReviewController::class, 'executeWaitlistBatch']);
        Route::get('absence-options', [CenterAbsenceReviewController::class, 'optionsPage']);
        Route::patch('absence-rules/{kind}/{id}', [CenterAbsenceReviewController::class, 'updateRule']);
        Route::get('group-instructor-options', [CenterStudyGroupController::class, 'instructorOptions']);
        Route::get('groups/{groupId}', [CenterStudyGroupController::class, 'workspace']);
        Route::post('groups', [CenterStudyGroupController::class, 'store']);
        Route::post('groups/{groupId}/start', [CenterStudyGroupController::class, 'start']);
        Route::patch('groups/{groupId}/settings', [CenterStudyGroupController::class, 'updateSettings']);
        Route::get('groups/{groupId}/sessions', [CenterStudySessionController::class, 'workspace']);
        Route::get('groups/{groupId}/coverage', [CenterStudyCoverageController::class, 'workspace']);
        Route::get('groups/{groupId}/plan-applications/options', [CenterStudyPlanApplicationController::class, 'options']);
        Route::post('groups/{groupId}/plan-applications/preview', [CenterStudyPlanApplicationController::class, 'preview']);
        Route::post('groups/{groupId}/plan-applications', [CenterStudyPlanApplicationController::class, 'store']);
        Route::post('groups/{groupId}/completion-threshold/preview', [CenterAttemptThresholdController::class, 'preview']);
        Route::post('groups/{groupId}/completion-threshold', [CenterAttemptThresholdController::class, 'store']);
        Route::post('groups/{groupId}/completion-preview', [CenterStudyCompletionController::class, 'preview']);
        Route::post('groups/{groupId}/completion', [CenterStudyCompletionController::class, 'store']);
        Route::post('groups/{groupId}/sessions/preview', [CenterStudySessionController::class, 'preview']);
        Route::post('groups/{groupId}/requirements/preview', [CenterGroupRequirementController::class, 'preview']);
        Route::post('groups/{groupId}/requirements', [CenterGroupRequirementController::class, 'store']);
        Route::get('groups/{groupId}/requirement-equivalences/requirements', [CenterGroupRequirementEquivalenceController::class, 'historicalRequirements']);
        Route::get('groups/{groupId}/requirement-equivalences/options', [CenterGroupRequirementEquivalenceController::class, 'options']);
        Route::post('groups/{groupId}/requirement-equivalences', [CenterGroupRequirementEquivalenceController::class, 'approve']);
        Route::post('groups/{groupId}/requirement-equivalences/{approvalId}/revoke', [CenterGroupRequirementEquivalenceController::class, 'revoke']);
        Route::post('groups/{groupId}/sessions', [CenterStudySessionController::class, 'store']);
        Route::patch('groups/{groupId}/sessions/{sessionId}/postpone', [CenterStudySessionController::class, 'postpone']);
        Route::get('groups/{groupId}/sessions/{sessionId}/cancel-preview', [CenterStudySessionController::class, 'cancelPreview']);
        Route::post('groups/{groupId}/sessions/{sessionId}/cancel', [CenterStudySessionController::class, 'cancel']);
        Route::post('groups/{groupId}/sessions/{sessionId}/replacement-preview', [CenterStudySessionController::class, 'replacementPreview']);
        Route::post('groups/{groupId}/sessions/{sessionId}/replacement', [CenterStudySessionController::class, 'replacement']);
        Route::get('groups/{groupId}/sessions/{sessionId}/attendance', [CenterStudyAttendanceController::class, 'workspace']);
        Route::get('groups/{groupId}/sessions/{sessionId}/teaching', [CenterStudyTeachingController::class, 'workspace']);
        Route::put('groups/{groupId}/sessions/{sessionId}/teaching', [CenterStudyTeachingController::class, 'save']);
        Route::get('groups/{groupId}/sessions/{sessionId}/attendance/{entryId}/note', [CenterStudentEventNoteController::class, 'attendanceShow']);
        Route::put('groups/{groupId}/sessions/{sessionId}/attendance/{entryId}/note', [CenterStudentEventNoteController::class, 'attendanceSave']);
        Route::post('groups/{groupId}/sessions/{sessionId}/attendance', [CenterStudyAttendanceController::class, 'record']);
        Route::post('groups/{groupId}/sessions/{sessionId}/attendance/{entryId}/undo', [CenterStudyAttendanceController::class, 'undo']);
        Route::post('groups/{groupId}/sessions/{sessionId}/attendance/{entryId}/correct', [CenterStudyAttendanceController::class, 'correct']);
        Route::get('groups/{groupId}/sessions/{sessionId}/revoke-preview', [CenterStudyAttendanceController::class, 'revokePreview']);
        Route::post('groups/{groupId}/sessions/{sessionId}/revoke', [CenterStudyAttendanceController::class, 'revoke']);
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
        Route::patch('student-branch-settings', [CenterSettingsController::class, 'updateStudentBranches']);
        Route::patch('student-numbering', [CenterStudentNumberingController::class, 'update']);
        Route::patch('settings', [CenterSettingsController::class, 'update']);
        Route::get('audit', [CenterAuditController::class, 'index']);
        Route::post('security/mfa/setup', [CenterSecurityController::class, 'setup'])->middleware('throttle:center-route');
        Route::post('security/mfa/confirm', [CenterSecurityController::class, 'confirm'])->middleware('throttle:center-route');
        Route::post('security/mfa/cancel', [CenterSecurityController::class, 'cancel'])->middleware('throttle:center-route');
        Route::post('security/mfa/disable', [CenterSecurityController::class, 'disable'])->middleware('throttle:center-route');
    });
});
