import type { AuditEntry } from "@/lib/server-context";
import { PrefetchLink as Link } from "@/components/PrefetchLink";

type Coverage = { covered_count?: number; required_count?: number; percentage?: number; missing_numbers?: number[] };
type Student = { attempt_id?: string; from_plan_version_id?: string; before?: Coverage; after?: Coverage;
  completion_decision_id?: string | null };

export function StudyPlanApplicationAuditDetails({ entry }: { entry: AuditEntry }) {
  if (entry.event !== "study_attempts.plan_version_applied") return null;
  let details = entry.details;
  if (typeof details === "string") { try { details = JSON.parse(details); } catch { return null; } }
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const data = details as Record<string, unknown>;
  const students = Array.isArray(data.students) ? data.students as Student[] : [];
  const groupId = typeof data.group_id === "string" ? data.group_id : "";
  const value = (coverage?: Coverage) => coverage && typeof coverage.covered_count === "number" && typeof coverage.required_count === "number"
    ? `${coverage.covered_count.toLocaleString("ar-EG")}/${coverage.required_count.toLocaleString("ar-EG")} · ${(coverage.percentage ?? 0).toLocaleString("ar-EG")}%`
    : "—";
  return <details><summary>تفاصيل تطبيق إصدار الخطة</summary>
    {groupId ? <p>المجموعة: <Link href={`/admin/groups/${encodeURIComponent(groupId)}/coverage`}>فتح تقرير التغطية</Link></p> : null}
    <p>المحاولات المختارة: {students.length.toLocaleString("ar-EG")} · سبب الاعتماد: {typeof data.reason === "string" ? data.reason : "—"}.</p>
    {students.map(student => <p key={student.attempt_id}>
      المحاولة <bdi dir="ltr">{student.attempt_id}</bdi>: {value(student.before)} ← {value(student.after)}.
      {student.completion_decision_id ? " قرار الإتمام السابق محفوظ." : ""}
    </p>)}
  </details>;
}
