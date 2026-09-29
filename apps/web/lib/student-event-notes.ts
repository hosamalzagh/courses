import type { CenterContext, StudentEventNote } from "@/lib/server-context";

export function canOpenStudentEventNote(note: Pick<StudentEventNote, "event_type" | "branch_id">,
  permissions: CenterContext["permissions"]): boolean {
  return note.event_type !== "study_attempt" || permissions.can_manage_center ||
    Boolean(permissions.branch_actions?.[String(note.branch_id)]?.includes("enrollment.manage"));
}

export function studentEventNoteOrigin(studentId: string, note: Pick<StudentEventNote, "event_type" | "event_id" | "group_id" | "session_id" | "payment_id">): string {
  if (note.event_type === "study_attempt") return `/admin/students/${studentId}/enrollments?attempt_id=${note.event_id}`;
  if (note.event_type.startsWith("attendance:") && note.group_id && note.session_id) {
    return `/admin/groups/${note.group_id}/sessions/${note.session_id}/attendance?entry_id=${note.event_id}`;
  }
  if ((note.event_type === "payment" || note.event_type === "allocation") && note.payment_id) {
    const query = new URLSearchParams({ payment_id: note.payment_id,
      ...(note.event_type === "allocation" ? { allocation_id: note.event_id } : {}) });
    return `/admin/students/${studentId}/account?${query}`;
  }
  if (["allocation_correction", "fee_adjustment", "refund", "refund_correction", "payment_correction"].includes(note.event_type)) {
    const query = new URLSearchParams({ financial_event_type: note.event_type, financial_event_id: note.event_id });
    return `/admin/students/${studentId}/account?${query}`;
  }
  return `/admin/students/${studentId}/account`;
}
