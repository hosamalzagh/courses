import type { AuditEntry } from "@/lib/server-context";
import { PrefetchLink as Link } from "@/components/PrefetchLink";

export function StudyCompletionAuditDetails({ entry }: { entry: AuditEntry }) {
  if (entry.event !== "study_group.completed" && entry.event !== "study_attempt.completed") return null;
  let details = entry.details;
  if (typeof details === "string") { try { details = JSON.parse(details); } catch { return null; } }
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const data = details as Record<string, unknown>;
  const groupId = typeof data.group_id === "string" ? data.group_id : "";
  const numbers = Array.isArray(data.missing_numbers)
    ? data.missing_numbers.filter((number): number is number => typeof number === "number") : [];
  return <details><summary>تفاصيل قرار الإتمام</summary>
    {groupId ? <p>المجموعة: <Link href={`/admin/groups/${encodeURIComponent(groupId)}/coverage`}>فتح تقرير المراجعة</Link></p> : null}
    {entry.event === "study_group.completed" ? <p>قبل: بدأت · بعد: مكتملة. اعتماد الطلاب قرار مستقل لكل محاولة.</p> : <>
      <p>المحاولة: <bdi dir="ltr">{typeof data.attempt_id === "string" ? data.attempt_id : "غير مسجلة"}</bdi></p>
      <p>قبل: نشطة · بعد: مكتملة {data.exceptional ? "استثنائيًا" : "بعد استيفاء الحد"}.</p>
      <p>التغطية وقت القرار: {typeof data.covered_count === "number" ? data.covered_count.toLocaleString("ar-EG") : "—"}/
        {typeof data.required_count === "number" ? data.required_count.toLocaleString("ar-EG") : "—"} · الحد: {typeof data.completion_threshold === "number" ? data.completion_threshold.toLocaleString("ar-EG") : "—"}%.</p>
      <p>المحاضرات الناقصة وقت القرار: {numbers.length ? numbers.map(number => number.toLocaleString("ar-EG")).join("، ") : "لا يوجد"}.</p>
      {typeof data.reason === "string" ? <p>سبب الاستثناء: {data.reason}</p> : null}
    </>}
  </details>;
}
