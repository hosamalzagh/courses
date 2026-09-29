import { redirect } from 'next/navigation';
export const metadata = { title: 'قوائم بيانات الطالب | Courses' };
export default async function Page({ searchParams }: { searchParams: Promise<{ kind?: string; page?: string; q?: string }> }) {
  const params = await searchParams;
  const query = new URLSearchParams({ tab: 'student-choices' });
  for (const key of ['kind', 'page', 'q'] as const) if (params[key]) query.set(key, params[key]!);
  redirect(`/admin/settings?${query}`);
}
