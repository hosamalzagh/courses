import "server-only";
import { CenterAccessState } from '@/components/CenterAccessState';
import { loadStudentSearchWorkspace } from '@/lib/server-context';
import { StudentSearchWorkspace } from './StudentSearchWorkspace';
import { redirect } from 'next/navigation';

export async function StudentSearchPageData({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  if (params.tab === 'settings') {
    const legacyQuery = new URLSearchParams({ tab: 'students' });
    for (const key of ['q', 'page'] as const) if (typeof params[key] === 'string') legacyQuery.set(key, params[key]);
    redirect(`/admin/settings?${legacyQuery}`);
  }
  const query = new URLSearchParams();
  for (const key of ['q', 'page']) if (typeof params[key] === 'string') query.set(key, params[key]);
  const context = await loadStudentSearchWorkspace(query.toString());
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  return <StudentSearchWorkspace context={context} query={typeof params.q === 'string' ? params.q : ''} />;
}
