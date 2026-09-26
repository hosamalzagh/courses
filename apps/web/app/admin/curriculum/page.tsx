import type { Metadata } from 'next';
import { loadCurriculumWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { CurriculumWorkspace } from './CurriculumWorkspace';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'منهج الفرع | Courses' };
export default async function CurriculumPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['courses_page', 'stages_page', 'levels_page', 'branches_page']) if (typeof params[key] === 'string') query.set(key, params[key]);
  const context = await loadCurriculumWorkspace(query.toString());
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  return <CurriculumWorkspace context={context} />;
}
