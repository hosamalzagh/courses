import "server-only";
import { loadCurriculumWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { CurriculumWorkspace } from '../CurriculumWorkspace';
export async function PlanPageData({ params }: { params: Promise<{ levelId: string }> }) {
  const { levelId } = await params;
  const context = await loadCurriculumWorkspace('', levelId);
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  return <CurriculumWorkspace context={context} detail />;
}
