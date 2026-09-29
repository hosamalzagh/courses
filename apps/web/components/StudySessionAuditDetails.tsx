import type { AuditEntry } from "@/lib/server-context";
import { formatSessionTime } from "@/lib/session-time";
import { PrefetchLink as Link } from "@/components/PrefetchLink";

export function StudySessionAuditDetails({ entry }: { entry: AuditEntry }) {
  const attendance = entry.event.startsWith("study_attendance.");
  const teaching = entry.event === "study_session.teaching_recorded" || entry.event === "study_session.teaching_corrected";
  const makeup = entry.event.startsWith("study_makeup.");
  if (!attendance && !teaching && !makeup && !["study_sessions.scheduled", "study_session.postponed", "study_session.revoked", "study_session.cancelled", "study_session.replacement_scheduled", "study_group.requirements_changed"].includes(entry.event)) return null;
  let details = entry.details;
  if (typeof details === "string") { try { details = JSON.parse(details); } catch { return null; } }
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const data = details as Record<string, unknown>;
  const date = (value: unknown) => typeof value === "string" ? formatSessionTime(value) : "غير مسجل";
  if (teaching) {
    const groupId = typeof data.group_id === "string" ? data.group_id : "";
    const sessionId = typeof data.session_id === "string" ? data.session_id : "";
    const rows = (value: unknown) => Array.isArray(value) ? value.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
    const list = (value: unknown) => <ul>{rows(value).map((item, index) => <li key={index}>
      {typeof item.instructor_name === "string" ? item.instructor_name : typeof item.instructor_id === "string" ? item.instructor_id : "محاضر غير مسجل"}
      {" "}· من الدقيقة {typeof item.start_minute === "number" ? item.start_minute.toLocaleString("ar-EG") : "—"}
      {" "}لمدة {typeof item.duration_minutes === "number" ? item.duration_minutes.toLocaleString("ar-EG") : "—"} دقيقة
    </li>)}</ul>;
    return <details><summary>تفاصيل التدريس الفعلي</summary>
      <p>المحاضرة: <bdi dir="ltr">{sessionId || "غير مسجلة"}</bdi></p>
      {groupId && sessionId ? <p><Link href={`/admin/groups/${encodeURIComponent(groupId)}/sessions/${encodeURIComponent(sessionId)}/teaching`}>فتح سجل التدريس</Link></p> : null}
      <p>قبل:</p>{list(data.before)}<p>بعد:</p>{list(data.after)}
      {typeof data.reason === "string" ? <p>سبب التصحيح: {data.reason}</p> : null}
    </details>;
  }
  if (makeup) {
    const groupId = typeof data.group_id === "string" ? data.group_id : "";
    const sessionId = typeof data.session_id === "string" ? data.session_id : "";
    return <details><summary>تفاصيل حضور التعويض</summary>
      <p>المحاولة: <bdi dir="ltr">{typeof data.attempt_id === "string" ? data.attempt_id : "غير مسجلة"}</bdi></p>
      {groupId && sessionId ? <p><Link href={`/admin/groups/${encodeURIComponent(groupId)}/sessions/${encodeURIComponent(sessionId)}/attendance`}>كشف محاضرة التعويض</Link></p> : null}
      <p>{entry.event === "study_makeup.booked" ? "حُجز التعويض دون احتساب تغطية." : "قبل: دون حضور تعويض · بعد: حاضر محتسب."}</p>
      {typeof data.reason === "string" ? <p>سبب الإثبات: {data.reason}</p> : null}
    </details>;
  }
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
        {typeof data.reason === "string" ? <p>السبب: {data.reason}</p> : null}
      </>}
    </details>;
  }
  return <details><summary>عرض تغيير جدول المحاضرات</summary>
    <p>المجموعة: <bdi>{typeof data.group_id === "string" ? data.group_id : "غير مسجلة"}</bdi></p>
    {entry.event === "study_sessions.scheduled" && Array.isArray(data.sessions) ? <ul>{data.sessions.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const item = value as Record<string, unknown>;
      return <li key={index}>الموعد {typeof item.number === "number" ? item.number.toLocaleString("ar-EG") : "—"} · المحاضرة المعتمدة {typeof item.plan_lecture_number === "number" ? item.plan_lecture_number.toLocaleString("ar-EG") : "—"} · {date(item.scheduled_at)}{typeof item.title === "string" ? ` · ${item.title}` : ""}</li>;
    })}</ul> : null}
    {entry.event === "study_session.postponed" ? <>
      <p>الموعد: <bdi>{typeof data.session_id === "string" ? data.session_id : "غير مسجل"}</bdi></p>
      <p>قبل: {date(data.before)} · بعد: {date(data.after)}</p>
      {typeof data.reason === "string" ? <p>السبب: {data.reason}</p> : null}
    </> : null}
    {entry.event === "study_session.revoked" ? <>
      <p>المحاضرة: <bdi dir="ltr">{typeof data.session_id === "string" ? data.session_id : "غير مسجلة"}</bdi></p>
      <p>قبل: منعقدة ومعتمدة · بعد: ملغى اعتمادها</p>
      {typeof data.reason === "string" ? <p>السبب: {data.reason}</p> : null}
      {data.impact && typeof data.impact === "object" && !Array.isArray(data.impact) ? <p>
        سجلات الحضور المتأثرة: {typeof (data.impact as { attendance?: { total?: number } }).attendance?.total === "number"
          ? (data.impact as { attendance: { total: number } }).attendance.total.toLocaleString("ar-EG") : "—"}
      </p> : null}
    </> : null}
    {entry.event === "study_session.cancelled" ? <>
      <p>الموعد الملغى: <bdi dir="ltr">{typeof data.session_id === "string" ? data.session_id : "غير مسجل"}</bdi> · الوقت الأصلي: {date(data.scheduled_at)}</p>
      <p>قرار التعويض: {data.decision === "academic" ? "بديل أكاديمي" : data.decision === "financial" ? "مراجعة مالية" : "دون تعويض"} · يبقى متطلب المحاضرة معتمدًا.</p>
      {typeof data.reason === "string" ? <p>السبب: {data.reason}</p> : null}
    </> : null}
    {entry.event === "study_session.replacement_scheduled" ? <>
      <p>الموعد الملغى: <bdi dir="ltr">{typeof data.cancelled_session_id === "string" ? data.cancelled_session_id : "غير مسجل"}</bdi></p>
      <p>الموعد البديل: <bdi dir="ltr">{typeof data.replacement_session_id === "string" ? data.replacement_session_id : "غير مسجل"}</bdi> · {date(data.scheduled_at)}</p>
      <p>بقي متطلب المحاضرة نفسه والقرار الأكاديمي محفوظًا دون إجراء مالي آلي.</p>
    </> : null}
    {entry.event === "study_group.requirements_changed" ? <>
      <p>القرار: {data.kind === "add" ? "محاضرة إضافية" : "إلغاء نهائي وخفض العدد"} · السبب: {typeof data.reason === "string" ? data.reason : "غير مسجل"}</p>
      <p>العدد المعتمد: {typeof (data.before as { required_count?: number } | null)?.required_count === "number" ? (data.before as { required_count: number }).required_count.toLocaleString("ar-EG") : "—"} ← {typeof (data.after as { required_count?: number } | null)?.required_count === "number" ? (data.after as { required_count: number }).required_count.toLocaleString("ar-EG") : "—"}</p>
      {typeof data.group_id === "string" ? <p><Link href={`/admin/groups/${encodeURIComponent(data.group_id)}/sessions`}>فتح جدول المجموعة</Link></p> : null}
      {typeof data.session_id === "string" ? <p>الموعد الملغى: <bdi dir="ltr">{data.session_id}</bdi></p> : null}
      {data.previous_decision === "academic" ? <p>قرار التعويض السابق: بديل أكاديمي · القرار النهائي: {data.decision === "financial" ? "مراجعة مالية" : "دون تعويض"}.</p> : null}
      {typeof data.affected_attempts === "number" ? <p>عدد المحاولات المتأثرة وقت الاعتماد: {data.affected_attempts.toLocaleString("ar-EG")}.</p> : null}
    </> : null}
  </details>;
}
