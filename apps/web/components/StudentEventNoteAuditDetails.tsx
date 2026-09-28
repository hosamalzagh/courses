import type { AuditEntry } from "@/lib/server-context";

export function StudentEventNoteAuditDetails({ entry }: { entry: AuditEntry }) {
  const attendance = ['student.attendance_note_created', 'student.attendance_note_updated'].includes(entry.event);
  if (!attendance && !['student.study_attempt_note_created', 'student.study_attempt_note_updated'].includes(entry.event)) return null;
  let details = entry.details;
  if (typeof details === "string") { try { details = JSON.parse(details); } catch { return null; } }
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const data = details as Record<string, unknown>;
  return <details><summary>تفاصيل ملاحظة {attendance ? "الحضور" : "التسجيل"}</summary>
    <p>الطالب: <bdi dir="ltr">{String(data.student_id ?? "")}</bdi> — {attendance ? "واقعة الحضور" : "المحاولة"}: <bdi dir="ltr">{String(attendance ? data.entry_id ?? "" : data.attempt_id ?? "")}</bdi></p>
    <p>نسخة {String(data.revision ?? "")} — {data.important ? "مهمة" : "عادية"}. نص الملاحظة متاح من الحدث المصرح به فقط.</p>
  </details>;
}
