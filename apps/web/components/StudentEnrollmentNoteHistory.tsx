"use client";

import type { CenterContext, StudentEnrollmentNotePage } from "@/lib/server-context";
import { StudentEventNotes } from "./StudentEventNotes";

export function StudentEnrollmentNoteHistory({ studentId, initial, permissions }: {
  studentId: string; initial: StudentEnrollmentNotePage; permissions: CenterContext["permissions"];
}) {
  return <StudentEventNotes studentId={studentId} initial={initial} permissions={permissions} enrollmentOnly />;
}
