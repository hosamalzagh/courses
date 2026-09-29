'use client';

import { useId } from "react";

import { FieldGroup, FieldSet } from "@/components/ui/field";
import { useEffect, useRef, useState, useTransition, type FormEvent } from 'react';
import { PrefetchLink as Link } from '@/components/PrefetchLink';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { CenterPageActions, CenterHeaderActions } from '@/components/CenterShell';
import { DataTable } from '@/components/DataTable';
import { FormField } from '@/components/FormField';
import { InlineNotice } from '@/components/InlineNotice';
import type { StudentSearchContext } from '@/lib/server-context';

export function StudentSearchControls({ context, query }: { context: StudentSearchContext; query: string }) {
  const formPrefix = useId();
  const router = useRouter();
  const [search, setSearch] = useState(query);
  const [loadedQuery, setLoadedQuery] = useState(query);
  if (loadedQuery !== query) { setLoadedQuery(query); setSearch(query); }
  const [pending, startTransition] = useTransition();
  const searchForm = useRef<HTMLFormElement>(null);
  const focusAfterClear = useRef(false);
  useEffect(() => {
    if (!pending && focusAfterClear.current) {
      searchForm.current?.querySelector<HTMLInputElement>('#center-student-search')?.focus();
      focusAfterClear.current = false;
    }
  }, [pending, query]);

  function navigate(value: string, page = 1) {
    const params = new URLSearchParams({ tab: 'search' });
    if (value) params.set('q', value);
    if (page > 1) params.set('page', String(page));
    startTransition(() => router.push(`/admin/student-search${params.size ? `?${params}` : ''}`));
  }

  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); navigate(search.trim()); }

  const searchView = <>
      {!context.policy.enabled ? <InlineNotice tone='warning'>البحث بين الفروع مغلق في هذا المركز. يمكنك العمل في ملفات الطلاب المصرح بها ضمن فروعك.</InlineNotice> : null}
      <form id={`${formPrefix}-0`} className='context-card form-stack' aria-label='البحث في البيانات الأساسية لطلاب المركز' noValidate ref={searchForm} onSubmit={submit} aria-busy={pending}>
<FieldGroup>
        <FieldSet disabled={!context.can_search || pending} style={{ border: 0, padding: 0, margin: 0 }}><FormField id='center-student-search' label='الاسم أو رقم الطالب الداخلي أو رقم التواصل' value={search} onChange={setSearch} hint='خارج فروعك تظهر الملفات التي تسمح بالمشاركة فقط عند فتح البحث العام ومنحك صلاحية البحث. النتائج لا تعرض سجلات الفروع.' /></FieldSet>
        <CenterHeaderActions><Button form={`${formPrefix}-0`} type='submit' variant='primary' busy={pending} disabled={!context.can_search}>بحث في طلاب المركز</Button>{search ? <Button disabled={pending} onClick={() => { setSearch(''); focusAfterClear.current = true; navigate(''); searchForm.current?.querySelector<HTMLInputElement>('#center-student-search')?.focus(); }}>مسح البحث</Button> : null}<Link href='/admin/students'>ملفات الطلاب ضمن فروعك</Link></CenterHeaderActions>
      </FieldGroup>
</form>
      <DataTable id='center-student-search-results' title='البيانات الأساسية المطابقة' description='حتى ٥٠ نتيجة في الدفعة؛ تصفية الجدول ضمن الدفعة الحالية فقط.' rows={context.students} rowKey={(student) => student.id} searchText={(student) => `${student.student_number} ${student.name} ${student.phone ?? ''}`} emptyMessage={!context.can_search ? 'البحث بين الفروع مغلق.' : query ? 'لا يوجد طالب مطابق في هذا المركز.' : 'أدخل بيانات الطالب لبدء البحث.'} columns={[
        { key: 'number', label: 'رقم الطالب الداخلي', filterText: (student) => String(student.student_number), render: (student) => <span className='table-code'>{student.student_number.toLocaleString('ar-EG')}</span> },
        { key: 'name', label: 'الطالب', filterText: (student) => student.name, render: (student) => <h3>{student.name}</h3> },
        { key: 'phone', label: 'رقم التواصل', filterText: (student) => student.phone ?? '', render: (student) => <bdi dir='ltr'>{student.phone || 'لم يُضف رقم تواصل'}</bdi> },
        { key: 'scope', label: 'إتاحة الملف', render: (student) => student.within_scope ? <Link href={`/admin/students/${student.id}`}>عرض الملف ضمن فروعك</Link> : <span className='muted'>بيانات أساسية فقط · خارج فروعك</span> },
      ]} />
      <nav className='form-actions' aria-label='دفعات نتائج بحث المركز'>{context.pagination.page > 1 ? <Button disabled={pending} onClick={() => navigate(query, context.pagination.page - 1)}>الدفعة السابقة</Button> : null}<span>دفعة {context.pagination.page.toLocaleString('ar-EG')}</span>{context.pagination.has_more ? <Button disabled={pending} onClick={() => navigate(query, context.pagination.page + 1)}>الدفعة التالية</Button> : null}</nav>
  </>;
  return <>
    <CenterPageActions context={context} />
    {searchView}
  </>;
}
