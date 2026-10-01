import 'server-only';
import { loadStudentWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { CenterPage } from '@/components/CenterPage';
import { StudentForm } from '../StudentForm';
export async function StudentNewPageData() {
  const context = await loadStudentWorkspace();
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  if (!context.permissions.can_manage_center && !Object.values(context.permissions.branch_actions ?? {}).some((actions) => actions.includes('students.manage'))) return <CenterAccessState state='forbidden' />;
  return <CenterPage context={context} path={'/admin/students/new'}><StudentForm key={context.workspace?.id ?? "center"} context={context} /></CenterPage>;
}
