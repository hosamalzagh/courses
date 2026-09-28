"use client";

import { StudentEventNoteEditor } from "@/components/StudentEventNoteEditor";
import type { StudyEnrollmentContext, StudyAttemptNote } from "@/lib/server-context";

type Attempt = StudyEnrollmentContext["attempts"][number];

export function StudyAttemptNoteEditor({ studentId, attempt, onClose, onSaved, onDirtyChange }: {
  studentId: string; attempt: Attempt; onClose: () => void;
  onSaved: (note: StudyAttemptNote) => void; onDirtyChange: (dirty: boolean) => void;
}) {
  return <StudentEventNoteEditor path={`students/${studentId}/enrollments/${attempt.id}/note`}
    title={`ملاحظة تسجيل ${attempt.group_name}`}
    description="الملاحظة اختيارية وترتبط بمحاولة الدراسة. لا تغير رسومها أو حالة التسجيل، ولا تحل محل سبب خصم أو تصحيح إلزامي."
    onClose={onClose} onSaved={onSaved} onDirtyChange={onDirtyChange} />;
}
