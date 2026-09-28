import type { StudentEventNote } from "@/lib/server-context";

export function studentEventNoteOrigin(studentId: string, note: Pick<StudentEventNote, "event_type" | "event_id" | "group_id" | "session_id">): string {
  if (note.event_type === "study_attempt") return `/admin/students/${studentId}/enrollments`;
  if (note.event_type.startsWith("attendance:") && note.group_id && note.session_id) {
    return `/admin/groups/${note.group_id}/sessions/${note.session_id}/attendance`;
  }
  return `/admin/students/${studentId}/account`;
}
