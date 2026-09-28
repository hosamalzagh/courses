import type { AuditEntry } from "@/lib/server-context";
import { formatSessionTime } from "@/lib/session-time";

export function StudySessionAuditDetails({ entry }: { entry: AuditEntry }) {
  if (entry.event !== "study_sessions.scheduled" && entry.event !== "study_session.postponed") return null;
  let details = entry.details;
  if (typeof details === "string") { try { details = JSON.parse(details); } catch { return null; } }
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const data = details as Record<string, unknown>;
  const date = (value: unknown) => typeof value === "string" ? formatSessionTime(value) : "غير مسجل";
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
