import { CenterPage } from "@/components/CenterPage";
import { GrantAuditDetails } from "@/components/GrantAuditDetails";
import { StudentAuditDetails } from "@/components/StudentAuditDetails";
import { InstructorAuditDetails } from "@/components/InstructorAuditDetails";
import { StudentNumberingAuditDetails } from "@/components/StudentNumberingAuditDetails";
import { StudentSearchAuditDetails } from "@/components/StudentSearchAuditDetails";
import { CurriculumAuditDetails } from "@/components/CurriculumAuditDetails";
import type { AuditEntry, CenterContext } from "@/lib/server-context";
import { AuditControls, type AuditRow } from "./AuditControls";

const eventNames: Record<string, string> = {
  "branch.created": "إنشاء فرع", "branch.updated": "تعديل فرع",
  "member.invited": "دعوة موظف", "member.status_changed": "تغيير حالة عضو",
  "member.grants_changed": "تغيير الأدوار والإسنادات", "invitation.accepted": "قبول دعوة",
  "member.branch_grants_changed": "تغيير أدوار الفرع",
  "member.branch_status_changed": "تغيير حالة موظف الفرع",
  "center.student_numbering_changed": "تغيير بداية ترقيم الطلاب",
  "center.settings_updated": "تعديل إعدادات المركز",
  "student.created": "إنشاء ملف طالب", "student.updated": "تعديل ملف طالب",
  "instructor.created": "إنشاء ملف محاضر", "instructor.updated": "تعديل ملف محاضر",
  "center.student_search_changed": "تغيير إتاحة البحث عن طلاب المركز",
  "curriculum.course_created": "إنشاء كورس", "curriculum.stage_created": "إنشاء مرحلة دراسية",
  "curriculum.level_created": "إنشاء مستوى", "curriculum.plan_updated": "تعديل الخطة الأولى",
};

export function AuditWorkspace({ context, initialEntries }: { context: CenterContext; initialEntries: AuditEntry[] }) {
  const rows: AuditRow[] = initialEntries.map((entry) => ({
    id: entry.id, event: eventNames[entry.event] ?? entry.event,
    scope: entry.branch_id ? `فرع رقم ${entry.branch_id}` : "المركز",
    actor: entry.actor_id === null ? "غير معروف" : `منفّذ رقم ${entry.actor_id}`,
    time: new Date(entry.created_at).toLocaleString("ar-EG", { timeZone: "Africa/Cairo" }),
    createdAt: entry.created_at, branch: entry.branch_id !== null,
    search: `${eventNames[entry.event] ?? entry.event} ${entry.branch_id ?? ""} ${entry.actor_id ?? ""}`,
    details: <><GrantAuditDetails entry={entry} /><StudentAuditDetails entry={entry} /><InstructorAuditDetails entry={entry} /><StudentSearchAuditDetails entry={entry} /><StudentNumberingAuditDetails entry={entry} /><CurriculumAuditDetails entry={entry} /></>,
  }));
  return <CenterPage context={context} path="/admin/audit"><AuditControls rows={rows} /></CenterPage>;
}
