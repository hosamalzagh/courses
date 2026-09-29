'use client';

import { StudentNavigationLink } from './StudentNavigationLink';
import { PrefetchLink as Link } from '@/components/PrefetchLink';
import { CenterPageActions } from '@/components/CenterShell';
import type { StudentContext } from '@/lib/server-context';
import { StudentLookup } from './StudentLookup';

export function StudentControls({ context, query, identifier = '', mode = 'general' }: { context: StudentContext; query: string; identifier?: string; mode?: 'general' | 'identifier' }) {
  const manageable = context.branches.some((branch) => context.permissions.can_manage_center || (context.permissions.branch_actions?.[String(branch.id)] ?? []).includes('students.manage'));
  const branchPage = context.pagination.branches_page;
  function branchPageHref(next: number) {
    const params = new URLSearchParams();
    if (context.pagination.page > 1) params.set('page', String(context.pagination.page));
    if (next > 1) params.set('branches_page', String(next));
    return `/admin/students${params.size ? `?${params}` : ''}`;
  }
  return <>
    <CenterPageActions context={context} actions={manageable ? <StudentNavigationLink primary focusKey='create' href='/admin/students/new'>إنشاء ملف طالب</StudentNavigationLink> : undefined} />
    <StudentLookup scope='branches' context={context} query={query} identifier={identifier} mode={mode} />
    {!query && !identifier && mode === 'general' && (context.pagination.branches_has_more || branchPage > 1) ? <nav className='form-actions' aria-label='صفحات فروع الطلاب'>
      {branchPage > 1 ? <Link href={branchPageHref(branchPage - 1)}>الفروع السابقة</Link> : null}
      <span>صفحة الفروع {branchPage.toLocaleString('ar-EG')}</span>
      {context.pagination.branches_has_more ? <Link href={branchPageHref(branchPage + 1)}>الفروع التالية</Link> : null}
    </nav> : null}
  </>;
}
