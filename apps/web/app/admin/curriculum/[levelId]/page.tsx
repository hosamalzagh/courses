import type { Metadata } from 'next';
import { loadCurriculumWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { CurriculumWorkspace } from '../CurriculumWorkspace';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'خطة المستوى | Courses' };
export default async function PlanPage({ params }: { params: Promise<{ levelId: string }> }) {
  const { levelId } = await params;
  const context = await loadCurriculumWorkspace('', levelId);
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  return <CurriculumWorkspace context={context} detail />;
}
