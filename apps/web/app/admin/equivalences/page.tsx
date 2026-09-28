import type { Metadata } from 'next';
import { CenterAccessState } from '@/components/CenterAccessState';
import { CenterPage } from '@/components/CenterPage';
import { loadContentEquivalences } from '@/lib/server-context';
import { ContentEquivalenceControls } from './ContentEquivalenceControls';

export const metadata: Metadata = { title: 'معادلة المحتوى | Courses' };

export default async function ContentEquivalencesPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const values = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['page', 'q']) if (typeof values[key] === 'string') query.set(key, values[key]);
  const context = await loadContentEquivalences(query.toString());
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  return <CenterPage context={context} path='/admin/equivalences'>
    <ContentEquivalenceControls context={context} />
  </CenterPage>;
}
