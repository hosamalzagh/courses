import "server-only";
import { loadStudentWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { StudentWorkspace } from './StudentWorkspace';
import { StudentCenterSearchWorkspace } from './StudentCenterSearchWorkspace';
import { loadStudentSearchWorkspace } from '@/lib/server-context';
import { canReadStudents, canSearchCenterStudents } from '@/lib/student-search-access';
import { redirect } from 'next/navigation';

export async function StudentsPageData({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  if (params.scope === 'center') {
    const query = new URLSearchParams();
    for (const key of ['q', 'page']) if (typeof params[key] === 'string') query.set(key, params[key]);
    const context = await loadStudentSearchWorkspace(query.toString());
    if (typeof context === 'string') return <CenterAccessState state={context} />;
    return <StudentCenterSearchWorkspace context={context} query={typeof params.q === 'string' ? params.q : ''} />;
  }
  const query = new URLSearchParams();
  for (const key of ['page', 'branches_page', 'q', 'identifier']) {
    if (typeof params[key] === 'string') query.set(key, params[key]);
  }
  const context = await loadStudentWorkspace(query.toString());
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  if (!canReadStudents(context) && canSearchCenterStudents(context)) redirect('/admin/students?scope=center');
  return <StudentWorkspace context={context} query={typeof params.q === 'string' ? params.q : ''} identifier={typeof params.identifier === 'string' ? params.identifier : ''} mode={params.mode === 'identifier' || params.identifier ? 'identifier' : 'general'} />;
}
