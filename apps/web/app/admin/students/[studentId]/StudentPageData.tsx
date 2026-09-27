import "server-only";
import { loadStudentWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { StudentWorkspace } from '../StudentWorkspace';

export async function StudentPageData({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = await params;
  const context = await loadStudentWorkspace('', studentId);
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  return <StudentWorkspace context={context} query='' detail />;
}
