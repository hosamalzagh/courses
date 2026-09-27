'use client';

import { useId } from "react";

import { FieldGroup, FieldSet } from "@/components/ui/field";


import { useEffect, useRef, useState, useTransition, type FormEvent } from 'react';
import { PrefetchLink as Link } from '@/components/PrefetchLink';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { CenterPageActions, CenterHeaderActions } from '@/components/CenterShell';
import { ConfirmationDialog } from '@/components/ConfirmationDialog';
import { WorkspaceSections } from '@/components/WorkspaceSections';
import { DataTable } from '@/components/DataTable';
import { FormField } from '@/components/FormField';
import { InlineNotice } from '@/components/InlineNotice';
import { centerRequest, responseMessage } from '@/lib/client-api';
import type { StudentSearchContext, StudentSearchPolicy } from '@/lib/server-context';

export function StudentSearchControls({ context, query, section = 'search' }: { context: StudentSearchContext; query: string; section?: 'search' | 'settings' }) {
  const formPrefix = useId();
  const router = useRouter();
  const [search, setSearch] = useState(query);
  const [policy, setPolicy] = useState(context.policy);
  const [loadedRevision, setLoadedRevision] = useState(context.policy.revision);
  const [loadedQuery, setLoadedQuery] = useState(query);
  if (loadedRevision !== context.policy.revision) { setLoadedRevision(context.policy.revision); setPolicy(context.policy); }
  if (loadedQuery !== query) { setLoadedQuery(query); setSearch(query); }
  const [confirmation, setConfirmation] = useState<'search' | 'default' | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const saving = useRef(false);
  const searchForm = useRef<HTMLFormElement>(null);
  const policyButton = useRef<HTMLButtonElement>(null);
  const focusAfterClear = useRef(false);
  useEffect(() => {
    if (!pending && focusAfterClear.current) {
      searchForm.current?.querySelector<HTMLInputElement>('#center-student-search')?.focus();
      focusAfterClear.current = false;
    }
  }, [pending, query]);

  async function savePolicy() {
    if (saving.current) return;
    saving.current = true; setConfirmation(null); setBusy(true); setError(''); setNotice('');
    try {
      const response = await centerRequest('student-search-policy', 'PATCH', { ...(confirmation === 'default' ? { default_sharing_enabled: !policy.default_sharing_enabled } : { enabled: !policy.enabled }), revision: policy.revision });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setError('تغيّر إعداد البحث. حمّل أحدث إعداد قبل التعديل.'); }
        else setError(await responseMessage(response));
        return;
      }
      const data = await response.json() as { policy: StudentSearchPolicy };
      setPolicy(data.policy); setConflict(false);
      setNotice(confirmation === 'default' ? 'حُفظ افتراضي مشاركة الملفات الجديدة. بقيت اختيارات الطلاب الموجودين محفوظة.' : data.policy.enabled ? 'فُعّل البحث في البيانات الأساسية لأصحاب صلاحية البحث المستقلة.' : 'عُطّل البحث بين الفروع. بقيت ملفات الطلاب وتاريخهم محفوظة.');
      router.refresh();
    } catch { setError('تعذر التأكد من حفظ الإعداد. حمّل أحدث حالة لمعرفة ما حُفظ قبل التعديل.'); setConflict(true); }
    finally { saving.current = false; setBusy(false); }
  }

  async function reloadPolicy() {
    if (saving.current) return;
    saving.current = true; setBusy(true);
    try {
      const response = await centerRequest('student-search-workspace', 'GET');
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const data = await response.json() as StudentSearchContext;
      setPolicy(data.policy); setConflict(false); setError(''); setNotice('حُمّل أحدث إعداد. راجعه قبل التعديل.');
      requestAnimationFrame(() => policyButton.current?.focus());
      router.refresh();
    } catch { setError('تعذر تحميل أحدث إعداد. تحقق من الاتصال وأعد المحاولة.'); }
    finally { saving.current = false; setBusy(false); }
  }

  function navigate(value: string, page = 1) {
    const params = new URLSearchParams({ tab: 'search' });
    if (value) params.set('q', value);
    if (page > 1) params.set('page', String(page));
    startTransition(() => router.push(`/admin/student-search${params.size ? `?${params}` : ''}`));
  }

  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); navigate(search.trim()); }

  const settings = <>
      <section className='context-card form-stack' aria-label='إتاحة البحث بين الفروع'>
        <h2>إتاحة البحث بين الفروع</h2>
        <p>الحالة: <strong>{policy.enabled ? 'مفعّل' : 'مغلق'}</strong>. يحتاج الموظف صلاحية البحث المستقلة؛ أدوار التسجيل وحدها لا تكفي.</p>
        {context.permissions.can_manage_center ? <CenterHeaderActions><Button ref={policyButton} busy={busy} disabled={conflict || pending} onClick={() => setConfirmation('search')}>{policy.enabled ? 'تعطيل البحث بين الفروع' : 'تفعيل البحث بين الفروع'}</Button>{conflict ? <Button disabled={busy} onClick={reloadPolicy}>تحميل أحدث إعداد</Button> : null}</CenterHeaderActions> : <p className='muted'>مالك المركز أو مسؤوله يغيّر هذا الإعداد.</p>}
      </section>
      {context.permissions.can_manage_center ? <section className='context-card form-stack' aria-label='افتراضي مشاركة الملفات الجديدة'>
        <h2>افتراضي مشاركة الملفات الجديدة</h2>
        <p>المشاركة عند الإنشاء: <strong>{policy.default_sharing_enabled ? 'مسموحة' : 'مغلقة'}</strong>. تغيير الافتراضي لا يغيّر اختيارات الطلاب الموجودين، ولا يفتح البحث العام.</p>
        <CenterHeaderActions><Button busy={busy} disabled={conflict || pending} onClick={() => setConfirmation('default')}>تغيير افتراضي المشاركة</Button></CenterHeaderActions>
      </section> : null}
  </>;
  const searchView = <>
      {!policy.enabled ? <InlineNotice tone='warning'>البحث بين الفروع مغلق في هذا المركز. يمكنك العمل في ملفات الطلاب المصرح بها ضمن فروعك.</InlineNotice> : null}
      <form id={`${formPrefix}-0`} className='context-card form-stack' aria-label='البحث في البيانات الأساسية لطلاب المركز' noValidate ref={searchForm} onSubmit={submit} aria-busy={pending}>
<FieldGroup>
        <FieldSet disabled={!context.can_search || busy || pending} style={{ border: 0, padding: 0, margin: 0 }}><FormField id='center-student-search' label='الاسم أو رقم الطالب الداخلي أو رقم التواصل' value={search} onChange={setSearch} hint='خارج فروعك تظهر الملفات التي تسمح بالمشاركة فقط عند فتح البحث العام ومنحك صلاحية البحث. النتائج لا تعرض سجلات الفروع.' /></FieldSet>
        <CenterHeaderActions><Button form={`${formPrefix}-0`} type='submit' variant='primary' busy={pending} disabled={!context.can_search || busy}>بحث في طلاب المركز</Button>{search ? <Button disabled={busy || pending} onClick={() => { setSearch(''); focusAfterClear.current = true; navigate(''); searchForm.current?.querySelector<HTMLInputElement>('#center-student-search')?.focus(); }}>مسح البحث</Button> : null}<Link href='/admin/students'>ملفات الطلاب ضمن فروعك</Link></CenterHeaderActions>
      </FieldGroup>
</form>
      <DataTable id='center-student-search-results' title='البيانات الأساسية المطابقة' description='حتى ٥٠ نتيجة في الدفعة؛ تصفية الجدول ضمن الدفعة الحالية فقط.' rows={context.students} rowKey={(student) => student.id} searchText={(student) => `${student.student_number} ${student.name} ${student.phone ?? ''}`} emptyMessage={!context.can_search ? 'البحث بين الفروع مغلق.' : query ? 'لا يوجد طالب مطابق في هذا المركز.' : 'أدخل بيانات الطالب لبدء البحث.'} columns={[
        { key: 'number', label: 'رقم الطالب الداخلي', filterText: (student) => String(student.student_number), render: (student) => <span className='table-code'>{student.student_number.toLocaleString('ar-EG')}</span> },
        { key: 'name', label: 'الطالب', filterText: (student) => student.name, render: (student) => <h3>{student.name}</h3> },
        { key: 'phone', label: 'رقم التواصل', filterText: (student) => student.phone ?? '', render: (student) => <bdi dir='ltr'>{student.phone || 'لم يُضف رقم تواصل'}</bdi> },
        { key: 'scope', label: 'إتاحة الملف', render: (student) => student.within_scope ? <Link href={`/admin/students/${student.id}`}>عرض الملف ضمن فروعك</Link> : <span className='muted'>بيانات أساسية فقط · خارج فروعك</span> },
      ]} />
      <nav className='form-actions' aria-label='دفعات نتائج بحث المركز'>{context.pagination.page > 1 ? <Button disabled={busy || pending} onClick={() => navigate(query, context.pagination.page - 1)}>الدفعة السابقة</Button> : null}<span>دفعة {context.pagination.page.toLocaleString('ar-EG')}</span>{context.pagination.has_more ? <Button disabled={busy || pending} onClick={() => navigate(query, context.pagination.page + 1)}>الدفعة التالية</Button> : null}</nav>
  </>;
  return <>
    <CenterPageActions context={context} />
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {error ? <InlineNotice tone='error'>{error}</InlineNotice> : null}
    <WorkspaceSections value={section} label='أقسام بحث طلاب المركز' path='/admin/student-search' sections={[
      { value: 'search', label: 'البحث عن طالب', content: searchView },
      ...(context.permissions.can_manage_center ? [{ value: 'settings', label: 'إعدادات المشاركة والبحث', content: settings }] : []),
    ]} />
      {confirmation ? <ConfirmationDialog title={confirmation === 'default' ? 'تغيير افتراضي مشاركة الملفات الجديدة' : policy.enabled ? 'تعطيل البحث بين الفروع' : 'تفعيل البحث بين الفروع'} description={confirmation === 'default' ? 'سيطبق الاختيار الجديد عند إنشاء ملفات جديدة فقط. تبقى اختيارات الطلاب الموجودين محفوظة، والبحث خارج الفروع يحتاج إعداد البحث ومنحة الموظف ومشاركة الطالب معًا.' : policy.enabled ? 'سيتوقف البحث خارج الفروع المسندة. تبقى ملفات الطلاب والارتباطات والتاريخ محفوظة.' : 'سيتمكن صاحب صلاحية البحث المستقلة من رؤية الاسم ورقم الطالب ورقم التواصل للطلاب الذين يسمحون بالمشاركة عبر فروع المركز. لا تُفتح السجلات الدراسية أو المالية ولا صلاحية التعديل.'} confirmLabel={confirmation === 'default' ? (policy.default_sharing_enabled ? 'غلق المشاركة للملفات الجديدة' : 'السماح بالمشاركة للملفات الجديدة') : policy.enabled ? 'تعطيل البحث' : 'تفعيل البحث'} onCancel={() => setConfirmation(null)} onConfirm={savePolicy} /> : null}
  </>;
}
