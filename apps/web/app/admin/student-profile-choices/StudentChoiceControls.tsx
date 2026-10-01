'use client';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useWorkspaceRouter as useRouter } from "@/components/WorkspaceNavigation";
import { PrefetchLink as Link } from '@/components/PrefetchLink';
import { Button } from '@/components/Button';
import { FormField } from '@/components/FormField';
import { InlineNotice } from '@/components/InlineNotice';
import { DataTable } from '@/components/DataTable';
import { CenterPageActions, CenterHeaderActions } from '@/components/CenterShell';
import { UnsavedChangesGuard } from '@/components/UnsavedChangesGuard';
import { FieldGroup, FieldSet, FieldLabel } from '@/components/ui/field';
import { Checkbox } from '@/components/ui/checkbox';
import { centerRequest, newSubmissionId, responseMessage, responseFieldErrors } from '@/lib/client-api';
import { studentChoiceLabels } from '@/lib/student-profile-choices';
import type { StudentChoiceContext, StudentProfileChoice, StudentChoiceKind } from '@/lib/server-context';

export function StudentChoiceControls({ context, kind, query }: { context: StudentChoiceContext; kind: string; query: string }) {
  const router = useRouter();
  const prefix = useId();
  const rows = context.choices;
  const [editor, setEditor] = useState<StudentProfileChoice | null>(null);
  const [label, setLabel] = useState('');
  const [position, setPosition] = useState('0');
  const [active, setActive] = useState(true);
  const [search, setSearch] = useState(query);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const opener = useRef<HTMLButtonElement | null>(null);
  const dirty = Boolean(editor && (label !== editor.label || position !== String(editor.position) || active !== editor.active));
  function open(choice: StudentProfileChoice, trigger?: HTMLButtonElement) {
    if (trigger) opener.current = trigger;
    setEditor(choice); setLabel(choice.label); setPosition(String(choice.position)); setActive(choice.active); setError(''); setErrors({}); setConflict(false);
  }
  function close() {
    setEditor(null); setError(''); setErrors({}); setConflict(false);
    requestAnimationFrame(() => opener.current?.focus());
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || saving.current || conflict) return;
    if (!label.trim()) { setErrors({ label: 'أدخل اسم الاختيار.' }); return; }
    if (!/^\d+$/.test(position) || Number(position) > 1000000) { setErrors({ position: 'أدخل ترتيبًا صحيحًا بين صفر و1000000.' }); return; }
    saving.current = true; setBusy(true); setError(''); setErrors({});
    try {
      const response = await centerRequest(`student-profile-choices${editor.revision ? `/${editor.id}` : ''}`, editor.revision ? 'PATCH' : 'POST', {
        label: label.trim(), position: Number(position), active,
        ...(editor.revision ? { revision: editor.revision } : { id: editor.id, kind }),
      });
      if (!response.ok) {
        setErrors(await responseFieldErrors(response)); setError(await responseMessage(response)); setConflict(response.status === 409); return;
      }
      close(); router.refresh();
    } catch { setError('تعذر حفظ الاختيار. مدخلاتك محفوظة؛ أعد نفس الطلب دون إضافة اختيار آخر.'); }
    finally { saving.current = false; setBusy(false); }
  }
  async function reload() {
    if (!editor || saving.current) return;
    saving.current = true; setBusy(true);
    try {
      const response = await centerRequest(`student-profile-choices/${editor.id}`, 'GET');
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const choice = (await response.json()).choice as StudentProfileChoice;
      open(choice);
      requestAnimationFrame(() => document.getElementById(`${prefix}-label`)?.focus());
    } catch { setError('تعذر تحميل الاختيار الحالي. أعد المحاولة.'); }
    finally { saving.current = false; setBusy(false); }
  }
  const href = (page: number) => `/admin/settings?${new URLSearchParams({ tab: 'student-choices', kind, page: String(page), q: query })}`;
  return <>
    <CenterPageActions context={context} />
    <UnsavedChangesGuard dirty={dirty} guardHistory />
    <nav className='form-actions' aria-label='قوائم بيانات الطالب'>{Object.entries(studentChoiceLabels).map(([key, value]) => <Link key={key} href={`/admin/settings?tab=student-choices&kind=${key}`} aria-current={key === kind ? 'page' : undefined}>{value}</Link>)}</nav>
    {error ? <InlineNotice tone='error'>{error}</InlineNotice> : null}
    <form id={`${prefix}-search`} className='context-card form-stack' onSubmit={event => { event.preventDefault(); router.push(`/admin/settings?${new URLSearchParams({ tab: 'student-choices', kind, q: search })}`); }}>
      <FieldGroup><FormField id={`${prefix}-query`} label='البحث في جميع اختيارات القائمة' value={search} onChange={setSearch} /></FieldGroup>
    </form>
    {editor ? <form id={`${prefix}-editor`} className='context-card form-stack' aria-label='تعديل اختيار القائمة' noValidate onSubmit={save}>
      <FieldGroup><FieldSet disabled={busy}>
        <FormField id={`${prefix}-label`} label='اسم الاختيار' value={label} onChange={setLabel} error={errors.label} focusOnMount required />
        <FormField id={`${prefix}-position`} label='الترتيب' value={position} onChange={setPosition} error={errors.position} direction='ltr' hint='الأرقام الأصغر تظهر أولًا.' />
        <FieldLabel className='flex items-center gap-2'><Checkbox checked={active} disabled={busy} onCheckedChange={checked => setActive(Boolean(checked))} />متاح للاستخدام الجديد</FieldLabel>
        <p className='muted'>تعطيل الاختيار يحفظ قيم الطلاب السابقة. تعديل الاسم يظهر في الملفات المرتبطة؛ يسجل التدقيق الاسم السابق.</p>
      </FieldSet></FieldGroup>
    </form> : null}
    <CenterHeaderActions>
      {editor ? <>{conflict ? <Button disabled={busy} onClick={reload}>تحميل الاختيار الحالي</Button> : null}<Button type='submit' form={`${prefix}-editor`} variant='primary' disabled={conflict} busy={busy}>حفظ الاختيار</Button><Button disabled={busy} onClick={close}>إلغاء</Button></> : <><Button variant='primary' onClick={event => open({ id: newSubmissionId(), kind: kind as StudentChoiceKind, label: '', position: 0, active: true, revision: 0 }, event.currentTarget)}>إضافة اختيار</Button><Button type='submit' form={`${prefix}-search`}>بحث في القائمة</Button></>}
    </CenterHeaderActions>
    <DataTable id={`student-choices-${kind}`} title={studentChoiceLabels[kind as StudentChoiceKind]} rows={rows} rowKey={choice => choice.id} searchText={choice => choice.label} emptyMessage='لا توجد اختيارات. أضف اختيارًا من الهيدر.' description='البحث داخل الدفعة المعروضة؛ البحث في الهيدر يشمل جميع اختيارات القائمة.' columns={[
      { key: 'label', label: 'الاختيار', render: choice => choice.label },
      { key: 'position', label: 'الترتيب', render: choice => choice.position.toLocaleString('ar-EG') },
      { key: 'active', label: 'الحالة', render: choice => choice.active ? 'متاح' : 'معطل — الاستعمالات السابقة محفوظة' },
      { key: 'actions', label: 'الإجراءات', actions: true, render: choice => <Button disabled={Boolean(editor) || busy} onClick={event => open(choice, event.currentTarget)}>تعديل</Button> },
    ]} />
    <nav className='form-actions' aria-label='صفحات القائمة'>{context.pagination.page > 1 ? <Link href={href(context.pagination.page-1)}>الدفعة السابقة</Link> : null}{context.pagination.has_more ? <Link href={href(context.pagination.page+1)}>الدفعة التالية</Link> : null}</nav>
  </>;
}
