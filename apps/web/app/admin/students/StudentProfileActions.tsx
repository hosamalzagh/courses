'use client';

import { CenterPageActions } from '@/components/CenterShell';
import type { StudentContext } from '@/lib/server-context';
import { StudentNavigationLink } from './StudentNavigationLink';

export function StudentProfileActions({ context }: { context: StudentContext }) {
  const student = context.students[0];
  return <CenterPageActions context={context} actions={student.can_manage ? <StudentNavigationLink focusKey='edit' href={`/admin/students/${student.id}/edit`}>تعديل ملف الطالب</StudentNavigationLink> : undefined} />;
}
