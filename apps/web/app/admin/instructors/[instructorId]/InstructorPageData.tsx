import "server-only";
import { loadInstructorWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { InstructorWorkspace } from '../InstructorWorkspace';

export async function InstructorPageData({ params }: { params: Promise<{ instructorId: string }> }) {
  const { instructorId } = await params;
  const context = await loadInstructorWorkspace('', instructorId);
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  return <InstructorWorkspace context={context} query='' detail />;
}
