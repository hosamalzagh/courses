import type { AuditEntry } from "@/lib/server-context";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function GrantAuditDetails({ entry }: { entry: AuditEntry }) {
  if (!["member.grants_changed", "member.branch_grants_changed"].includes(entry.event)) return null;
  let details = entry.details;
  if (typeof details === "string") {
    try { details = JSON.parse(details); } catch { return null; }
  }
  const data = record(details);
  const labels = record(data.role_labels);
  const centerLabels: Record<string, string> = { center_owner: "مالك المركز", center_admin: "مسؤول المركز" };
  const names = (value: unknown) => Array.isArray(value)
    ? value.filter((role): role is string => typeof role === "string").map((role) => typeof labels[role] === "string" ? labels[role] : centerLabels[role] ?? "صلاحية غير معروفة").join("، ") || "دون أدوار"
    : "غير مسجل";
  const before = record(data.branch_roles_before);
  const after = record(data.branch_roles_after);
  const branches = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((id) => /^[1-9]\d*$/.test(id));
  return <details><summary>عرض تغيير الأدوار</summary>
    <p>موظف رقم {typeof data.user_id === "number" ? data.user_id : "غير معروف"}</p>
    {entry.branch_id !== null ? <><p>قبل التغيير: {names(data.roles_before)}</p><p>بعد التغيير: {names(data.roles_after)}</p></> : <>
      <p>أدوار المركز قبل التغيير: {names(data.center_roles_before)}</p>
      <p>أدوار المركز بعد التغيير: {names(data.center_roles_after ?? data.center_roles)}</p>
      {branches.map((id) => <div key={id}><strong>فرع رقم {id}</strong><p>قبل التغيير: {names(before[id] ?? [])}</p><p>بعد التغيير: {names(after[id] ?? [])}</p></div>)}
      {!Object.hasOwn(data, "branch_roles_before") ? <p>قيم إسنادات الفروع السابقة غير مسجلة لهذا الحدث القديم.</p> : null}
    </>}
  </details>;
}
