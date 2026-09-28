"use client";

import type { StudentEnrollmentNotePage } from "@/lib/server-context";
import { StudentEventNotes } from "./StudentEventNotes";

export function StudentEnrollmentNoteHistory({ studentId, initial }: { studentId: string; initial: StudentEnrollmentNotePage }) {
  return <StudentEventNotes studentId={studentId} initial={initial} enrollmentOnly />;
}
