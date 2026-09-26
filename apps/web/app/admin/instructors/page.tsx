import type { Metadata } from 'next';
import { loadInstructorWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { InstructorWorkspace } from './InstructorWorkspace';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'ملفات المحاضرين | Courses' };

export default async function InstructorsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['page', 'branches_page', 'q']) {
    if (typeof params[key] === 'string') query.set(key, params[key]);
  }
  const context = await loadInstructorWorkspace(query.toString());
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  return <InstructorWorkspace context={context} query={typeof params.q === 'string' ? params.q : ''} />;
}
