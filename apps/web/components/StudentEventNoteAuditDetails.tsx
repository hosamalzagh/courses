import type { AuditEntry } from "@/lib/server-context";

export function StudentEventNoteAuditDetails({ entry }: { entry: AuditEntry }) {
  if (!['student.study_attempt_note_created', 'student.study_attempt_note_updated'].includes(entry.event)) return null;
  let details = entry.details;
  if (typeof details === "string") { try { details = JSON.parse(details); } catch { return null; } }
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const data = details as Record<string, unknown>;
  return <details><summary>تفاصيل ملاحظة التسجيل</summary>
    <p>الطالب: <bdi dir="ltr">{String(data.student_id ?? "")}</bdi> — المحاولة: <bdi dir="ltr">{String(data.attempt_id ?? "")}</bdi></p>
    <p>نسخة {String(data.revision ?? "")} — {data.important ? "مهمة" : "عادية"}. نص الملاحظة متاح من حدث التسجيل فقط.</p>
  </details>;
}
