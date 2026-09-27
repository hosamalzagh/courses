import type { AuditEntry } from "@/lib/server-context";

export function StudentNumberingAuditDetails({ entry }: { entry: AuditEntry }) {
  if (entry.event !== "center.student_numbering_changed") return null;
  let details = entry.details;
  if (typeof details === "string") {
    try { details = JSON.parse(details); } catch { return null; }
  }
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const data = details as { before?: unknown; after?: unknown };
  const number = (value: unknown) => typeof value === "number" ? value.toLocaleString("ar-EG") : "غير مسجل";
  return <details><summary>عرض تغيير بداية الترقيم</summary><p>قبل التغيير: {number(data.before)}</p><p>بعد التغيير: {number(data.after)}</p></details>;
}
