import type { StudentEventNote } from "@/lib/server-context";

export function studentEventNoteOrigin(studentId: string, note: Pick<StudentEventNote, "event_type" | "event_id" | "group_id" | "session_id" | "payment_id">): string {
  if (note.event_type === "study_attempt") return `/admin/students/${studentId}/enrollments`;
  if (note.event_type.startsWith("attendance:") && note.group_id && note.session_id) {
    return `/admin/groups/${note.group_id}/sessions/${note.session_id}/attendance`;
  }
  if ((note.event_type === "payment" || note.event_type === "allocation") && note.payment_id) {
    const query = new URLSearchParams({ payment_id: note.payment_id,
      ...(note.event_type === "allocation" ? { allocation_id: note.event_id } : {}) });
    return `/admin/students/${studentId}/account?${query}`;
  }
  return `/admin/students/${studentId}/account`;
}
