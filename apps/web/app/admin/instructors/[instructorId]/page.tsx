import type { Metadata } from 'next';
import { loadInstructorWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { InstructorWorkspace } from '../InstructorWorkspace';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'ملف المحاضر | Courses' };

export default async function InstructorPage({ params }: { params: Promise<{ instructorId: string }> }) {
  const { instructorId } = await params;
  const context = await loadInstructorWorkspace('', instructorId);
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  return <InstructorWorkspace context={context} query='' detail />;
}
