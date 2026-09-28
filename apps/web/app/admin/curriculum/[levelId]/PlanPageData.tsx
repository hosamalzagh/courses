import "server-only";
import { loadCurriculumWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { CurriculumWorkspace } from '../CurriculumWorkspace';
export async function PlanPageData({ params, searchParams }: { params: Promise<{ levelId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { levelId } = await params;
  const values = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['plan_version', 'versions_page']) if (typeof values[key] === 'string') query.set(key, values[key]);
  const context = await loadCurriculumWorkspace(query.toString(), levelId);
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  return <CurriculumWorkspace context={context} detail />;
}
