import type { AuditEntry } from "@/lib/server-context";

const kinds: Record<string, string> = { courses: "كورس", stages: "مرحلة دراسية", levels: "مستوى", study_groups: "مجموعة" };

function describe(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "غير مسجلة";
  const rule = value as Record<string, unknown>;
  if (rule.mode === null) return "موروثة";
  if (rule.mode === "disabled") return "التنبيه معطل";
  const type = rule.mode === "total" ? "إجمالي" : "متتالٍ";
  return typeof rule.limit === "number" ? `${rule.limit.toLocaleString("ar-EG")} غياب ${type}` : "لم يُحدد الحد";
}

export function AbsenceAuditDetails({ entry }: { entry: AuditEntry }) {
  if (entry.event !== "study_absence.rule_changed") return null;
  let details = entry.details;
  if (typeof details === "string") { try { details = JSON.parse(details); } catch { return null; } }
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const data = details as Record<string, unknown>;
  return <details><summary>عرض تغيير قاعدة الغياب</summary>
    <p>{kinds[String(data.kind)] ?? "نطاق دراسي"} · <bdi dir="ltr">{String(data.record_id ?? "")}</bdi></p>
    <p>قبل: {describe(data.before)}</p><p>بعد: {describe(data.after)}</p>
  </details>;
}
