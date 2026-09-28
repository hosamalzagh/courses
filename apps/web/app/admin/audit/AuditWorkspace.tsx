import { CenterPage } from "@/components/CenterPage";
import { GrantAuditDetails } from "@/components/GrantAuditDetails";
import { StudentAuditDetails } from "@/components/StudentAuditDetails";
import { InstructorAuditDetails } from "@/components/InstructorAuditDetails";
import { StudentNumberingAuditDetails } from "@/components/StudentNumberingAuditDetails";
import { StudentSearchAuditDetails } from "@/components/StudentSearchAuditDetails";
import { CurriculumAuditDetails } from "@/components/CurriculumAuditDetails";
import { StudentFinanceAuditDetails } from "@/components/StudentFinanceAuditDetails";
import { StudentEventNoteAuditDetails } from "@/components/StudentEventNoteAuditDetails";
import { StudySessionAuditDetails } from "@/components/StudySessionAuditDetails";
import { StudyCompletionAuditDetails } from "@/components/StudyCompletionAuditDetails";
import { AbsenceAuditDetails } from "@/components/AbsenceAuditDetails";
import { ContentEquivalenceAuditDetails } from "@/components/ContentEquivalenceAuditDetails";
import type { AuditEntry, CenterContext } from "@/lib/server-context";
import { AuditControls, type AuditRow } from "./AuditControls";

const eventNames: Record<string, string> = {
  "center.student_custom_field_changed": "تغيير تعريف حقل إضافي للطالب",
  "center.student_profile_choice_changed": "تغيير قائمة بيانات الطالب",
  "branch.created": "إنشاء فرع", "branch.updated": "تعديل فرع",
  "member.invited": "دعوة موظف", "member.status_changed": "تغيير حالة عضو",
  "member.grants_changed": "تغيير الأدوار والإسنادات", "invitation.accepted": "قبول دعوة",
  "member.branch_grants_changed": "تغيير أدوار الفرع",
  "member.branch_status_changed": "تغيير حالة موظف الفرع",
  "center.student_numbering_changed": "تغيير بداية ترقيم الطلاب",
  "center.settings_updated": "تعديل إعدادات المركز",
  "center.financial_currency_changed": "تغيير عملة المركز",
  "student.payment_recorded": "استلام دفعة مقدمة للطالب",
  "student.payment_allocated": "تخصيص دفعة مقدمة لرسوم محاولة الدراسة",
  "student.payment_allocation_reversed": "عكس تخصيص دفعة مقدمة",
  "student.payment_allocation_corrected": "تصحيح تخصيص دفعة مقدمة",
  "student.fee_settled": "اعتماد تسوية رسوم محاولة دراسة",
  "student.fee_settlement_corrected": "تصحيح تسوية رسوم محاولة دراسة",
  "student.payment_note_created": "إضافة ملاحظة على دفعة الطالب",
  "student.payment_note_updated": "تعديل ملاحظة دفعة الطالب",
  "student.allocation_note_created": "إضافة ملاحظة على تخصيص الدفعة",
  "student.allocation_note_updated": "تعديل ملاحظة تخصيص الدفعة",
  "student.enrolled": "تسجيل طالب ورسوم محاولة الدراسة",
  "student.study_repeated": "إعادة دراسة الطالب بمحاولة ورسوم جديدتين",
  "student.study_withdrawn": "انسحاب الطالب من محاولة الدراسة",
  "student.study_waitlisted": "نقل الطالب إلى انتظار المستوى",
  "student.study_reattached": "إعادة إلحاق الطالب بالمحاولة نفسها",
  "student.study_transferred": "نقل محاولة الدراسة بين المجموعات أو الفروع",
  "student.study_bulk_waitlist_skipped": "استبعاد طالب من نقل جماعي إلى الانتظار",
  "student.study_attempt_note_created": "إضافة ملاحظة على تسجيل الطالب",
  "student.study_attempt_note_updated": "تعديل ملاحظة تسجيل الطالب",
  "student.attendance_note_created": "إضافة ملاحظة على حضور أو غياب الطالب",
  "student.attendance_note_updated": "تعديل ملاحظة حضور أو غياب الطالب",
  "student.sharing_changed": "تغيير مشاركة الطالب", "center.student_sharing_default_changed": "تغيير افتراضي مشاركة الملفات الجديدة",
  "student.photo_changed": "تغيير صورة الطالب", "student.created": "إنشاء ملف طالب", "student.updated": "تعديل ملف طالب", "student.suspended": "إيقاف ملف طالب", "student.reactivated": "فك إيقاف ملف طالب",
  "student.attachments_added": "إضافة مرفقات للطالب", "student.attachment_replace": "استبدال وثيقة الطالب",
  "student.attachment_classify": "تغيير تصنيف وثيقة الطالب", "student.attachment_archive": "أرشفة وثيقة الطالب",
  "student.attachment_restore": "استعادة وثيقة الطالب",
  "instructor.created": "إنشاء ملف محاضر", "instructor.updated": "تعديل ملف محاضر",
  "center.student_search_changed": "تغيير إتاحة البحث عن طلاب المركز",
  "curriculum.course_created": "إنشاء كورس", "curriculum.stage_created": "إنشاء مرحلة دراسية",
  "curriculum.course_copied": "نسخ منهج كورس إلى فرع",
  "curriculum.level_created": "إنشاء مستوى", "curriculum.plan_updated": "تعديل الخطة الأولى",
  "curriculum.plan_version_created": "إنشاء إصدار خطة المستوى",
  "content.equivalence_approved": "اعتماد معادلة المحتوى",
  "curriculum.completion_threshold_changed": "تغيير نسبة إتمام المنهج",
  "study_attempts.completion_threshold_applied": "تطبيق نسبة الإتمام على تسجيلات قائمة",
  "study_group.created": "إنشاء مجموعة", "study_group.started": "بدء مجموعة",
  "study_group.completed": "إكمال مجموعة", "study_attempt.completed": "اعتماد إتمام دراسة طالب",
  "study_group.settings_updated": "تعديل إعدادات مجموعة",
  "study_sessions.scheduled": "جدولة محاضرات مجموعة",
  "study_session.postponed": "تأجيل محاضرة مجموعة",
  "study_session.cancelled": "إلغاء موعد محاضرة قبل انعقادها",
  "study_session.replacement_scheduled": "جدولة بديل لموعد ملغى",
  "study_attendance.recorded": "تسجيل حضور طالب",
  "study_attendance.undone": "التراجع عن حضور طالب",
  "study_attendance.closed": "إغلاق كشف حضور محاضرة",
  "study_attendance.corrected": "تصحيح حضور في كشف مغلق",
  "study_session.revoked": "إلغاء اعتماد محاضرة منعقدة",
  "study_session.teaching_recorded": "تسجيل التدريس الفعلي لمحاضرة",
  "study_session.teaching_corrected": "تصحيح التدريس الفعلي لمحاضرة",
  "study_attendance.suspension_backfilled": "إضافة استثناءات إيقاف إلى كشف مغلق",
  "study_absence.rule_changed": "تعديل قاعدة تنبيه الغياب",
};

export function AuditWorkspace({ context, initialEntries }: { context: CenterContext; initialEntries: AuditEntry[] }) {
  const rows: AuditRow[] = initialEntries.map((entry) => ({
    id: entry.id, event: eventNames[entry.event] ?? entry.event,
    scope: entry.branch_id ? `فرع رقم ${entry.branch_id}` : "المركز",
    actor: entry.event === "study_attendance.suspension_backfilled" ? "ترحيل النظام" : entry.actor_id === null ? "غير معروف" : `منفّذ رقم ${entry.actor_id}`,
    time: new Date(entry.created_at).toLocaleString("ar-EG", { timeZone: "Africa/Cairo" }),
    createdAt: entry.created_at, branch: entry.branch_id !== null,
    search: `${eventNames[entry.event] ?? entry.event} ${entry.branch_id ?? ""} ${entry.actor_id ?? ""}`,
    details: <><GrantAuditDetails entry={entry} /><StudentAuditDetails entry={entry} /><StudentFinanceAuditDetails entry={entry} /><StudentEventNoteAuditDetails entry={entry} /><InstructorAuditDetails entry={entry} /><StudentSearchAuditDetails entry={entry} /><StudentNumberingAuditDetails entry={entry} /><CurriculumAuditDetails entry={entry} /><ContentEquivalenceAuditDetails entry={entry} /><StudySessionAuditDetails entry={entry} /><StudyCompletionAuditDetails entry={entry} /><AbsenceAuditDetails entry={entry} /></>,
  }));
  return <CenterPage context={context} path="/admin/audit"><AuditControls rows={rows} /></CenterPage>;
}
