'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { StudentNavigationLink } from './StudentNavigationLink';
import { PrefetchLink as Link } from '@/components/PrefetchLink';
import { CenterPageActions } from '@/components/CenterShell';
import { DataTable } from '@/components/DataTable';
import { Button } from '@/components/Button';
import { FormField } from '@/components/FormField';
import type { StudentContext } from '@/lib/server-context';

export function StudentControls({ context, query }: { context: StudentContext; query: string }) {
  const router = useRouter();
  const [search, setSearch] = useState(query);
  const manageable = context.branches.filter((branch) => context.permissions.can_manage_center || (context.permissions.branch_actions?.[String(branch.id)] ?? []).includes('students.manage'));

  function pageLink(page: number, branchesPage = context.pagination.branches_page) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (page > 1) params.set('page', String(page));
    if (branchesPage > 1) params.set('branches_page', String(branchesPage));
    return `/admin/students${params.size ? `?${params}` : ''}`;
  }

  return <>
    <CenterPageActions context={context} actions={manageable.length ? <StudentNavigationLink primary focusKey='create' href='/admin/students/new'>إنشاء ملف طالب</StudentNavigationLink> : undefined} />
      <form className='context-card form-stack' noValidate onSubmit={(event) => { event.preventDefault(); router.push(`/admin/students?${new URLSearchParams({ q: search })}`); }} aria-label='البحث في جميع ملفات الطلاب'>
        <FormField id='student-global-search' label='البحث في جميع الملفات المصرح بها' value={search} onChange={setSearch} hint='الاسم أو رقم الطالب الداخلي أو رقم التواصل. لا يشمل الفروع المحجوبة.' />
        <div className='form-actions'><Button type='submit' variant='primary' >بحث عن طالب</Button>{search ? <Button onClick={() => { setSearch(''); document.getElementById('student-global-search')?.focus(); router.push('/admin/students'); }}>مسح البحث</Button> : null}</div>
      </form>
      {(context.pagination.branches_has_more || context.pagination.branches_page > 1) ? <nav className='form-actions' aria-label='صفحات فروع الطلاب'>{context.pagination.branches_page > 1 ? <Link href={pageLink(context.pagination.page, context.pagination.branches_page - 1)}>الفروع السابقة</Link> : null}<span>صفحة الفروع {context.pagination.branches_page.toLocaleString('ar-EG')}</span>{context.pagination.branches_has_more ? <Link href={pageLink(context.pagination.page, context.pagination.branches_page + 1)}>الفروع التالية</Link> : null}</nav> : null}
      <DataTable id='students' title='سجل الطلاب' description={'تصفية الجدول ضمن هذه الدفعة (حتى ٥٠ ملفًا). استخدم البحث أعلاه للبحث في جميع الملفات المصرح بها.'} rows={context.students} rowKey={(student) => student.id} searchText={(student) => `${student.student_number} ${student.name} ${student.phone ?? ''}`} emptyMessage={query ? 'لا يوجد طالب مطابق ضمن نطاق صلاحيتك.' : 'لا توجد ملفات طلاب متاحة. أنشئ ملفًا إذا كانت لديك صلاحية التسجيل.'}
        columns={[
          { key: 'number', label: 'رقم الطالب الداخلي', filterText: (student) => String(student.student_number), render: (student) => <Link className='table-code' href={`/admin/students/${student.id}`}>{student.student_number.toLocaleString('ar-EG')}</Link> },
          { key: 'name', label: 'الطالب', filterText: (student) => student.name, render: (student) => <h3>{student.name}</h3> },
          { key: 'phone', label: 'رقم التواصل', filterText: (student) => student.phone ?? '', render: (student) => <bdi dir='ltr'>{student.phone || 'لم يُضف رقم تواصل'}</bdi> },
          { key: 'branches', label: 'الفروع المصرح بها', filterText: (student) => student.branch_ids.map((id) => context.branches.find((branch) => branch.id === id)?.name ?? `فرع رقم ${id}`).join('، '), render: (student) => student.branch_ids.map((id) => context.branches.find((branch) => branch.id === id)?.name ?? `فرع رقم ${id}`).join('، ') },
          { key: 'actions', label: 'الإجراءات', actions: true, render: (student) => student.can_manage ? <Link href={`/admin/students/${student.id}/edit`}>تعديل ملف الطالب</Link> : <span className='muted'>صلاحية عرض فقط</span> },
        ]} />
      <nav className='form-actions' aria-label='دفعات ملفات الطلاب'>{context.pagination.page > 1 ? <Link href={pageLink(context.pagination.page - 1)}>دفعة الملفات السابقة</Link> : null}<span>دفعة {context.pagination.page.toLocaleString('ar-EG')}</span>{context.pagination.has_more ? <Link href={pageLink(context.pagination.page + 1)}>دفعة الملفات التالية</Link> : null}</nav>
  </>;
}
