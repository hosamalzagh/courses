import "server-only";
import { CenterAccessState } from '@/components/CenterAccessState';
import { loadStudentSearchWorkspace } from '@/lib/server-context';
import { StudentSearchWorkspace } from './StudentSearchWorkspace';

export async function StudentSearchPageData({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['q', 'page']) if (typeof params[key] === 'string') query.set(key, params[key]);
  const context = await loadStudentSearchWorkspace(query.toString());
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  return <StudentSearchWorkspace context={context} query={typeof params.q === 'string' ? params.q : ''} />;
}
