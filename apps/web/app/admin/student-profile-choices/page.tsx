import { loadStudentChoiceWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { CenterPage } from '@/components/CenterPage';
import { StudentChoiceControls } from './StudentChoiceControls';
export const metadata = { title: 'قوائم بيانات الطالب | Courses' };
export default async function Page({ searchParams }: { searchParams: Promise<{ kind?: string; page?: string; q?: string }> }) {
  const params = await searchParams;
  const kind = params.kind ?? 'city';
  const context = await loadStudentChoiceWorkspace(kind, params.page ?? '1', params.q ?? '');
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  if (!context.permissions.can_manage_center) return <CenterAccessState state='forbidden' />;
  return <CenterPage context={context} path='/admin/student-profile-choices'><StudentChoiceControls key={`${kind}:${params.page}:${params.q}`} context={context} kind={kind} query={params.q ?? ''} /></CenterPage>;
}
