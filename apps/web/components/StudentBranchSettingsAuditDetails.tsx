import type { AuditEntry } from "@/lib/server-context";

export function StudentBranchSettingsAuditDetails({ entry }: { entry: AuditEntry }) {
  if (entry.event !== "center.student_all_branches_settings_changed") return null;
  let details = entry.details;
  if (typeof details === "string") {
    try { details = JSON.parse(details); } catch { return null; }
  }
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const data = details as { before?: unknown; after?: unknown };
  const status = (value: unknown) => value === true ? "مفعّل" : value === false ? "مغلق" : "غير مسجل";
  return <details><summary>عرض تغيير ربط الفروع</summary><p>قبل التغيير: {status(data.before)}</p><p>بعد التغيير: {status(data.after)}</p></details>;
}
