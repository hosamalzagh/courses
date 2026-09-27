import 'server-only';
import { loadStudentWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { CenterPage } from '@/components/CenterPage';
import { StudentForm } from '../../StudentForm';
export async function StudentEditPageData({ params }: { params: Promise<{ studentId: string }> }) {
  const studentId = (await params).studentId;
  const context = await loadStudentWorkspace('', studentId);
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  if (!context.students[0].can_manage) return <CenterAccessState state='forbidden' />;
  return <CenterPage context={context} path={`/admin/students/${studentId}/edit`}><StudentForm key={`${context.students[0].id}:${context.students[0].revision}`} context={context} student={context.students[0]} /></CenterPage>;
}
