'use client';

import { useId } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { FieldGroup, FieldSet, FieldLegend, FieldLabel } from "@/components/ui/field";


import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { PrefetchLink as Link } from '@/components/PrefetchLink';
import { CenterPageActions, CenterHeaderActions } from '@/components/CenterShell';
import { DataTable } from '@/components/DataTable';
import { Button } from '@/components/Button';
import { FormField } from '@/components/FormField';
import { UnsavedChangesGuard } from '@/components/UnsavedChangesGuard';
import { InlineNotice } from '@/components/InlineNotice';
import { centerRequest, newSubmissionId, responseFieldErrors, responseMessage } from '@/lib/client-api';
import type { Instructor, InstructorContext } from '@/lib/server-context';

export function InstructorControls({ context, query, detail = false }: { context: InstructorContext; query: string; detail?: boolean }) {
  const formPrefix = useId();
  const router = useRouter();
  const [editor, setEditor] = useState<Instructor | 'new' | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [branchIds, setBranchIds] = useState<number[]>([]);
  const [search, setSearch] = useState(query);
  const [requestId, setRequestId] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [initialValues, setInitialValues] = useState('');
  const dirty = editor !== null && JSON.stringify([name, phone, [...branchIds].sort((a, b) => a - b)]) !== initialValues;
  const manageable = context.branches.filter((branch) => context.permissions.can_manage_center || (context.permissions.branch_actions?.[String(branch.id)] ?? []).includes('instructors.manage'));

  function open(instructor: Instructor | 'new', preserveTrigger = false) {
    if (!preserveTrigger) trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditor(instructor); setName(instructor === 'new' ? '' : instructor.name); setPhone(instructor === 'new' ? '' : instructor.phone ?? '');
    const selected = instructor === 'new' ? manageable.slice(0, 1).map((branch) => branch.id) : instructor.branch_ids.filter((id) => manageable.some((branch) => branch.id === id));
    setBranchIds(selected);
    setInitialValues(JSON.stringify([instructor === 'new' ? '' : instructor.name, instructor === 'new' ? '' : instructor.phone ?? '', [...selected].sort((a, b) => a - b)]));
    setRequestId(newSubmissionId()); setError(''); setFieldErrors({}); setNotice(''); setConflict(false);
  }

  function close() {
    setEditor(null); setError('');
    requestAnimationFrame(() => trigger.current?.isConnected && trigger.current.focus());
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || saving.current) return;
    setError(''); setFieldErrors({}); setNotice('');
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = 'أدخل اسم المحاضر.';
    if (editor === 'new' && !branchIds.length) errors.branch_ids = 'اختر فرعًا مصرحًا به على الأقل.';
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      if (!errors.name && errors.branch_ids) requestAnimationFrame(() => document.querySelector<HTMLInputElement>('#instructor-branches input')?.focus());
      return;
    }
    saving.current = true; setBusy(true);
    try {
      const response = await centerRequest(editor === 'new' ? 'instructors' : `instructors/${editor.id}`, editor === 'new' ? 'POST' : 'PATCH', {
        name: name.trim(), phone: phone.trim() || null, branch_ids: branchIds,
        ...(editor === 'new' ? { request_id: requestId } : { revision: editor.revision }),
      });
      if (!response.ok) {
        if (response.status === 409) {
          setConflict(true);
          setError('تغيّرت بيانات الملف أو الطلب. راجع أحدث بيانات المحاضر قبل إعادة الحفظ.');
        } else if (response.status === 404) {
          setError('ملف المحاضر لم يعد متاحًا ضمن صلاحيتك. راجع مسؤول المركز.');
        } else {
          setFieldErrors(await responseFieldErrors(response)); setError(await responseMessage(response));
        }
        return;
      }
      const created = editor === 'new';
      close(); setNotice(created ? 'أُنشئ ملف المحاضر دون حساب دخول.' : 'حُفظت بيانات المحاضر والفروع المرتبطة به.');
      router.refresh();
    } catch { setError('تعذر حفظ الملف. تحقق من الاتصال وأعد المحاولة؛ إعادة الطلب لا تنشئ ملفًا مكررًا.'); }
    finally { saving.current = false; setBusy(false); }
  }

  async function reloadInstructor() {
    if (!editor) return;
    setBusy(true);
    try {
      const response = await centerRequest(editor === 'new' ? `instructors/submissions/${requestId}` : `instructors/${editor.id}`, 'GET');
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const data = await response.json() as InstructorContext & { instructor?: Instructor };
      const wasNew = editor === 'new';
      open(wasNew ? data.instructor! : data.instructors[0], true);
      if (wasNew) setNotice('الملف حُفظ سابقًا. راجع بياناته قبل تعديلها؛ لن يُنشأ ملف آخر.');
      router.refresh();
    } catch { setError('تعذر تحميل أحدث البيانات. حاول مرة أخرى.'); }
    finally { setBusy(false); }
  }

  function pageLink(page: number, branchesPage = context.pagination.branches_page) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (page > 1) params.set('page', String(page));
    if (branchesPage > 1) params.set('branches_page', String(branchesPage));
    return `/admin/instructors${params.size ? `?${params}` : ''}`;
  }

  return <>
    <CenterPageActions context={context} actions={manageable.length && !detail ? <Button hidden={editor !== null} variant='primary' disabled={busy} onClick={() => open('new')}>إنشاء ملف محاضر</Button> : undefined} />
    <UnsavedChangesGuard dirty={dirty} />
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      {error ? <InlineNotice tone='error'>{error}</InlineNotice> : null}
      {detail ? <Link href='/admin/instructors'>العودة إلى ملفات المحاضرين</Link> : <form id={`${formPrefix}-0`} className='context-card form-stack' noValidate onSubmit={(event) => { event.preventDefault(); router.push(`/admin/instructors?${new URLSearchParams({ q: search })}`); }} aria-label='البحث في جميع ملفات المحاضرين'>
<FieldGroup>
        <FormField id='instructor-global-search' label='البحث في جميع الملفات المصرح بها' value={search} onChange={setSearch} hint='الاسم أو رقم التواصل. لا يشمل الفروع المحجوبة.' />
        <CenterHeaderActions><Button form={`${formPrefix}-0`} type='submit' variant='primary' disabled={busy}>بحث عن محاضر</Button>{search || query ? <Button disabled={busy} onClick={() => { setSearch(''); router.push('/admin/instructors'); document.getElementById('instructor-global-search')?.focus(); }}>مسح البحث</Button> : null}</CenterHeaderActions>
      </FieldGroup>
</form>}
      {editor ? <form id={`${formPrefix}-1`} className='context-card form-stack' aria-label={editor === 'new' ? 'ملف محاضر جديد' : `تعديل ملف ${editor.name}`} noValidate onSubmit={save}>
<FieldGroup>
        <h2>{editor === 'new' ? 'ملف محاضر جديد' : `تعديل ملف ${editor.name}`}</h2>
        <FieldSet disabled={busy} className="form-stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <FormField id='instructor-name' label='اسم المحاضر' focusOnMount value={name} onChange={(value) => { setName(value); setFieldErrors({}); }} error={fieldErrors.name} required autoComplete='off' />
        <FormField id='instructor-phone' label='رقم التواصل' value={phone} onChange={(value) => { setPhone(value); setFieldErrors({}); }} error={fieldErrors.phone} type='tel' direction='ltr' autoComplete='off' hint='اختياري، ويمكن لأكثر من محاضر استخدام نفس الرقم.' />
        <FieldSet id='instructor-branches' data-invalid={Boolean(fieldErrors.branch_ids)} aria-describedby={fieldErrors.branch_ids ? 'instructor-branches-error' : 'instructor-branches-hint'}><FieldLegend>الفروع المرتبطة بالمحاضر</FieldLegend>
          <p id='instructor-branches-hint' className='muted'>اختر الفروع المصرح بها للإسناد. تبقى ارتباطات الملف السابقة محفوظة.</p>
          {manageable.map((branch) => {
            const associated = editor !== 'new' && editor.branch_ids.includes(branch.id);
            return <FieldLabel key={branch.id} className="flex items-center gap-2"><Checkbox aria-invalid={Boolean(fieldErrors.branch_ids)} checked={branchIds.includes(branch.id)} disabled={busy || associated} onCheckedChange={(checked) => { setBranchIds((ids) => checked ? [...ids, branch.id] : ids.filter((id) => id !== branch.id)); setFieldErrors({}); }} />{branch.name}{associated ? ' — مرتبط بالفعل' : ''}</FieldLabel>;
          })}
          {fieldErrors.branch_ids ? <p id='instructor-branches-error' className='field-error' role='alert'>{fieldErrors.branch_ids}</p> : null}
        </FieldSet>
<CenterHeaderActions>{conflict ? <Button disabled={busy} onClick={reloadInstructor}>تحميل أحدث بيانات المحاضر</Button> : null}<Button form={`${formPrefix}-1`} type='submit' variant='primary' busy={busy} disabled={conflict}>{editor === 'new' ? 'حفظ ملف المحاضر' : 'حفظ بيانات المحاضر'}</Button><Button disabled={busy} onClick={close}>إلغاء</Button></CenterHeaderActions>
        </FieldSet>
      </FieldGroup>
</form> : null}
      {!editor && (context.pagination.branches_has_more || context.pagination.branches_page > 1) ? <nav className='form-actions' aria-label='صفحات فروع المحاضرين'>{context.pagination.branches_page > 1 ? <Link href={pageLink(context.pagination.page, context.pagination.branches_page - 1)}>الفروع السابقة</Link> : null}<span>صفحة الفروع {context.pagination.branches_page.toLocaleString('ar-EG')}</span>{context.pagination.branches_has_more ? <Link href={pageLink(context.pagination.page, context.pagination.branches_page + 1)}>الفروع التالية</Link> : null}</nav> : null}
      <DataTable id='instructors' title='سجل المحاضرين' description={detail ? 'البيانات الأساسية للملف ضمن الفروع المصرح بها.' : 'تصفية الجدول ضمن هذه الدفعة (حتى ٥٠ ملفًا). استخدم البحث أعلاه للبحث في جميع الملفات المصرح بها.'} rows={context.instructors} rowKey={(instructor) => instructor.id} searchText={(instructor) => `${instructor.name} ${instructor.phone ?? ''}`} emptyMessage={query ? 'لا يوجد محاضر مطابق ضمن نطاق صلاحيتك.' : 'لا توجد ملفات محاضرين متاحة. أنشئ ملفًا إذا كانت لديك صلاحية الإدارة الأكاديمية.'}
        columns={[
          { key: 'name', label: 'المحاضر', filterText: (instructor) => instructor.name, render: (instructor) => <Link href={`/admin/instructors/${instructor.id}`}>{instructor.name}</Link> },
          { key: 'phone', label: 'رقم التواصل', filterText: (instructor) => instructor.phone ?? '', render: (instructor) => <bdi dir='ltr'>{instructor.phone || 'لم يُضف رقم تواصل'}</bdi> },
          { key: 'branches', label: 'الفروع المصرح بها', filterText: (instructor) => instructor.branch_ids.map((id) => context.branches.find((branch) => branch.id === id)?.name ?? `فرع رقم ${id}`).join('، '), render: (instructor) => instructor.branch_ids.map((id) => context.branches.find((branch) => branch.id === id)?.name ?? `فرع رقم ${id}`).join('، ') },
          { key: 'actions', label: 'الإجراءات', actions: true, render: (instructor) => instructor.can_manage ? <Button disabled={busy} onClick={() => open(instructor)}>تعديل ملف المحاضر</Button> : <span className='muted'>صلاحية عرض فقط</span> },
        ]} />
      {!detail ? <nav className='form-actions' aria-label='دفعات ملفات المحاضرين'>{context.pagination.page > 1 ? <Link href={pageLink(context.pagination.page - 1)}>دفعة الملفات السابقة</Link> : null}<span>دفعة {context.pagination.page.toLocaleString('ar-EG')}</span>{context.pagination.has_more ? <Link href={pageLink(context.pagination.page + 1)}>دفعة الملفات التالية</Link> : null}</nav> : null}
  </>;
}
