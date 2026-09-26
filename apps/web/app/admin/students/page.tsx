import type { Metadata } from 'next';
import { loadStudentWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { StudentWorkspace } from './StudentWorkspace';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'ملفات الطلاب | Courses' };

export default async function StudentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['page', 'branches_page', 'q']) {
    if (typeof params[key] === 'string') query.set(key, params[key]);
  }
  const context = await loadStudentWorkspace(query.toString());
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  return <StudentWorkspace context={context} query={typeof params.q === 'string' ? params.q : ''} />;
}
