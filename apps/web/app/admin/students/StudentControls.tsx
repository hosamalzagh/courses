'use client';

import { useId } from "react";

import { FieldGroup } from "@/components/ui/field";


import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { StudentNavigationLink } from './StudentNavigationLink';
import { PrefetchLink as Link } from '@/components/PrefetchLink';
import { StudentSharingControls } from './StudentSharingControls';
import { CenterPageActions, CenterHeaderActions } from '@/components/CenterShell';
import { WorkspaceSections } from '@/components/WorkspaceSections';
import { DataTable } from '@/components/DataTable';
import { Button } from '@/components/Button';
import { ChoiceField } from '@/components/ChoiceField';
import { FormField } from '@/components/FormField';
import type { StudentContext } from '@/lib/server-context';

export function StudentControls({ context, query, identifier = '', section = 'register' }: { context: StudentContext; query: string; identifier?: string; section?: 'register' | 'search' }) {
  const formPrefix = useId();
  const router = useRouter();
  const [search, setSearch] = useState(identifier || query);
  const [mode, setMode] = useState(identifier ? 'identifier' : 'general');
  const [loadedSearch, setLoadedSearch] = useState([query, identifier]);
  if (loadedSearch[0] !== query || loadedSearch[1] !== identifier) {
    setLoadedSearch([query, identifier]); setSearch(identifier || query); setMode(identifier ? 'identifier' : 'general');
  }
  const manageable = context.branches.filter((branch) => context.permissions.can_manage_center || (context.permissions.branch_actions?.[String(branch.id)] ?? []).includes('students.manage'));

  function pageLink(page: number, branchesPage = context.pagination.branches_page) {
    const params = new URLSearchParams({ tab: section });
    if (query) params.set('q', query);
    if (identifier) params.set('identifier', identifier);
    if (page > 1) params.set('page', String(page));
    if (branchesPage > 1) params.set('branches_page', String(branchesPage));
    return `/admin/students${params.size ? `?${params}` : ''}`;
  }

  const searchForm = <>
      <form id={`${formPrefix}-0`} className='context-card form-stack' noValidate onSubmit={(event) => { event.preventDefault(); router.push(`/admin/students?${new URLSearchParams({ tab: 'search', [mode === 'identifier' ? 'identifier' : 'q']: search })}`); }} aria-label='البحث في جميع ملفات الطلاب'>
<FieldGroup>
        <ChoiceField id={`${formPrefix}-search-mode`} label='طريقة البحث' value={mode} onChange={setMode} items={[{value:'general',label:'الاسم / التواصل / الرقم الداخلي'},{value:'identifier',label:'الرقم الداخلي / الباركود'}]} />
        <FormField id='student-global-search' label='البحث في جميع الملفات المصرح بها' value={search} onChange={setSearch} hint={mode === 'identifier' ? `مسح أو بحث برقم الطالب الداخلي${context.student_code_settings.enabled ? ` أو ${context.student_code_settings.label}` : ''}، يعيد ملفًا واحدًا مصرحًا به.` : 'الاسم أو رقم الطالب الداخلي أو رقم التواصل المشترك. لا يشمل الفروع المحجوبة.'} />
        <CenterHeaderActions><Button form={`${formPrefix}-0`} type='submit' variant='primary' >بحث عن طالب</Button>{search ? <Button onClick={() => { setSearch(''); document.getElementById('student-global-search')?.focus(); router.push('/admin/students?tab=search'); }}>مسح البحث</Button> : null}</CenterHeaderActions>
      </FieldGroup>
</form>
    </>;
  const register = <>
      {(context.pagination.branches_has_more || context.pagination.branches_page > 1) ? <nav className='form-actions' aria-label='صفحات فروع الطلاب'>{context.pagination.branches_page > 1 ? <Link href={pageLink(context.pagination.page, context.pagination.branches_page - 1)}>الفروع السابقة</Link> : null}<span>صفحة الفروع {context.pagination.branches_page.toLocaleString('ar-EG')}</span>{context.pagination.branches_has_more ? <Link href={pageLink(context.pagination.page, context.pagination.branches_page + 1)}>الفروع التالية</Link> : null}</nav> : null}
      <DataTable id='students' title='سجل الطلاب' description={'حتى ٥٠ ملفًا في الدفعة. للبحث عبر جميع الملفات استخدم تبويب البحث.'} rows={context.students} rowKey={(student) => student.id} searchText={(student) => `${student.student_number} ${student.name} ${student.phone ?? ''}`} emptyMessage={query || identifier ? 'لا يوجد طالب مطابق ضمن نطاق صلاحيتك.' : 'لا توجد ملفات طلاب متاحة. أنشئ ملفًا إذا كانت لديك صلاحية التسجيل.'}
        columns={[
          { key: 'number', label: 'رقم الطالب الداخلي', filterText: (student) => String(student.student_number), render: (student) => <Link className='table-code' href={`/admin/students/${student.id}`}>{student.student_number.toLocaleString('ar-EG')}</Link> },
          { key: 'name', label: 'الطالب', filterText: (student) => student.name, render: (student) => <h3>{student.name}</h3> },
          { key: 'status', label: 'حالة الملف', filterText: (student) => student.status === 'active' ? 'نشط' : 'موقوف', render: (student) => student.status === 'active' ? 'نشط' : 'موقوف' },
          { key: 'phone', label: 'رقم التواصل', filterText: (student) => student.phone ?? '', render: (student) => <bdi dir='ltr'>{student.phone || 'لم يُضف رقم تواصل'}</bdi> },
          { key: 'branches', label: 'الفروع المصرح بها', filterText: (student) => student.branch_ids.map((id) => context.branches.find((branch) => branch.id === id)?.name ?? `فرع رقم ${id}`).join('، '), render: (student) => student.branch_ids.map((id) => context.branches.find((branch) => branch.id === id)?.name ?? `فرع رقم ${id}`).join('، ') },
          { key: 'actions', label: 'الإجراءات', actions: true, render: (student) => <div className='student-row-actions'>{student.can_manage ? <Link href={`/admin/students/${student.id}/edit`}>تعديل ملف الطالب</Link> : <span className='muted'>صلاحية عرض فقط</span>}<StudentSharingControls student={student} compact /></div> },
        ]} />
      <nav className='form-actions' aria-label='دفعات ملفات الطلاب'>{context.pagination.page > 1 ? <Link href={pageLink(context.pagination.page - 1)}>دفعة الملفات السابقة</Link> : null}<span>دفعة {context.pagination.page.toLocaleString('ar-EG')}</span>{context.pagination.has_more ? <Link href={pageLink(context.pagination.page + 1)}>دفعة الملفات التالية</Link> : null}</nav>
  </>;
  return <>
    <CenterPageActions context={context} actions={manageable.length ? <StudentNavigationLink primary focusKey='create' href='/admin/students/new'>إنشاء ملف طالب</StudentNavigationLink> : undefined} />
    <WorkspaceSections value={section} label='أقسام ملفات الطلاب' path='/admin/students' sections={[
      { value: 'register', label: 'سجل الطلاب', resetParams: ['q', 'identifier', 'page'], content: register },
      { value: 'search', label: 'البحث عن طالب', content: <>{searchForm}{register}</> },
    ]} />
  </>;
}
