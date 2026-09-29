import "server-only";
import { redirect } from 'next/navigation';

export async function StudentSearchPageData({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  if (params.tab === 'settings') {
    const legacyQuery = new URLSearchParams({ tab: 'students' });
    for (const key of ['q', 'page'] as const) if (typeof params[key] === 'string') legacyQuery.set(key, params[key]);
    return redirect(`/admin/settings?${legacyQuery}`);
  }
  const query = new URLSearchParams({ scope: 'center' });
  for (const key of ['q', 'page']) if (typeof params[key] === 'string') query.set(key, params[key]);
  return redirect(`/admin/students?${query}`);
}
