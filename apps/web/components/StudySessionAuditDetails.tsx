import type { AuditEntry } from "@/lib/server-context";
import { formatSessionTime } from "@/lib/session-time";
import { PrefetchLink as Link } from "@/components/PrefetchLink";

export function StudySessionAuditDetails({ entry }: { entry: AuditEntry }) {
  const attendance = entry.event.startsWith("study_attendance.");
  if (!attendance && entry.event !== "study_sessions.scheduled" && entry.event !== "study_session.postponed") return null;
  let details = entry.details;
  if (typeof details === "string") { try { details = JSON.parse(details); } catch { return null; } }
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const data = details as Record<string, unknown>;
  const date = (value: unknown) => typeof value === "string" ? formatSessionTime(value) : "غير مسجل";
  if (attendance) {
    const groupId = typeof data.group_id === "string" ? data.group_id : "";
    const sessionId = typeof data.session_id === "string" ? data.session_id : "";
    const statuses: Record<string, string> = { counted: "حاضر محتسب", not_counted: "حاضر غير محتسب", absent: "غائب" };
    const status = (value: unknown) => typeof value === "string" ? statuses[value] ?? value : "غير مسجل";
    const absentIds = Array.isArray(data.absent_attempt_ids) ? data.absent_attempt_ids.filter((value): value is string => typeof value === "string") : [];
    const absentCount = typeof data.absent_count === "number" && Number.isInteger(data.absent_count) ? data.absent_count : absentIds.length;
    const suspendedCount = typeof data.suspended_count === "number" && Number.isInteger(data.suspended_count) ? data.suspended_count : 0;
    return <details><summary>تفاصيل حضور المحاضرة</summary>
      <p>المجموعة: <bdi dir="ltr">{groupId || "غير مسجلة"}</bdi> — المحاضرة: <bdi dir="ltr">{sessionId || "غير مسجلة"}</bdi></p>
      {groupId && sessionId ? <p><Link href={`/admin/groups/${encodeURIComponent(groupId)}/sessions/${encodeURIComponent(sessionId)}/attendance`}>فتح كشف الحضور</Link></p> : null}
      {entry.event === "study_attendance.suspension_backfilled" ?
        <p>أضاف ترحيل البيانات {suspendedCount.toLocaleString("ar-EG")} استثناء إيقاف إلى هذا الكشف المغلق، دون تعديل سجل الإغلاق الأصلي.</p> : entry.event === "study_attendance.closed" ? <>
        <p>اعتمد الغياب لـ {absentCount.toLocaleString("ar-EG")} طالب مستحق غير مسجل.</p>
        {suspendedCount > 0 ? <p>استُبعد {suspendedCount.toLocaleString("ar-EG")} طالب بسبب الإيقاف دون تسجيل حضور أو غياب.</p> : null}
        {absentIds.length ? <p>معرّفات المحاولات: {absentIds.slice(0, 20).join("، ")}{absentCount > 20 ? `، و${(absentCount - 20).toLocaleString("ar-EG")} أخرى` : ""}</p> : null}
      </> : <>
        <p>المحاولة: <bdi dir="ltr">{typeof data.attempt_id === "string" ? data.attempt_id : "غير مسجلة"}</bdi></p>
        <p>قبل: {status(data.before)} · بعد: {status(data.after)}</p>
      </>}
    </details>;
  }
  return <details><summary>عرض تغيير جدول المحاضرات</summary>
    <p>المجموعة: <bdi>{typeof data.group_id === "string" ? data.group_id : "غير مسجلة"}</bdi></p>
    {entry.event === "study_sessions.scheduled" && Array.isArray(data.sessions) ? <ul>{data.sessions.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const item = value as Record<string, unknown>;
      return <li key={index}>الموعد {typeof item.number === "number" ? item.number.toLocaleString("ar-EG") : "—"} · محاضرة الخطة {typeof item.plan_lecture_number === "number" ? item.plan_lecture_number.toLocaleString("ar-EG") : "—"} · {date(item.scheduled_at)}{typeof item.title === "string" ? ` · ${item.title}` : ""}</li>;
    })}</ul> : null}
    {entry.event === "study_session.postponed" ? <>
      <p>الموعد: <bdi>{typeof data.session_id === "string" ? data.session_id : "غير مسجل"}</bdi></p>
      <p>قبل: {date(data.before)} · بعد: {date(data.after)}</p>
      {typeof data.reason === "string" ? <p>السبب: {data.reason}</p> : null}
    </> : null}
  </details>;
}
