import type { Metadata } from 'next';
import { loadStudentWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { StudentWorkspace } from '../StudentWorkspace';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'ملف الطالب | Courses' };

export default async function StudentPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = await params;
  const context = await loadStudentWorkspace('', studentId);
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  return <StudentWorkspace context={context} query='' detail />;
}
