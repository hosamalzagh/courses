'use client';

import { useId } from "react";

import { Field } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import { FieldGroup, FieldSet, FieldLegend, FieldLabel } from "@/components/ui/field";

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PrefetchLink as Link } from '@/components/PrefetchLink';
import { CenterPageActions, CenterHeaderActions } from '@/components/CenterShell';
import { WorkspaceSections } from '@/components/WorkspaceSections';
import { DataTable } from '@/components/DataTable';
import { Button } from '@/components/Button';
import { FormField } from '@/components/FormField';
import { UnsavedChangesGuard } from '@/components/UnsavedChangesGuard';
import { InlineNotice } from '@/components/InlineNotice';
import { centerRequest, newSubmissionId, responseFieldErrors, responseMessage } from '@/lib/client-api';
import type { Course, CurriculumContext, Level, PlanLecture, Stage } from '@/lib/curriculum';
type Editor = { kind: 'course' } | { kind: 'stage'; course: Course } | { kind: 'level'; stage: Stage } | { kind: 'plan'; level: Level };
type LectureDraft = Omit<PlanLecture, 'planned_hours'> & { planned_hours: string };
const blankLecture = (): LectureDraft => ({ number: 1, content: '', title: null, planned_hours: '1' });
export function CurriculumControls({ context, detail = false, section = 'courses' }: { context: CurriculumContext; detail?: boolean; section?: 'courses' | 'stages' | 'levels' }) {
  const formPrefix = useId();
  const router = useRouter();
  const searchParams = useSearchParams();
  function openSection(next: 'courses' | 'stages' | 'levels') {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', next); router.push(`/admin/curriculum?${params}`);
  }
  const [editor, setEditor] = useState<Editor | null>(null);
  const [loadedSection, setLoadedSection] = useState(section);
  const [name, setName] = useState('');
  const [branchId, setBranchId] = useState(0);
  const [lectures, setLectures] = useState<LectureDraft[]>([blankLecture()]);
  const [requestId, setRequestId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const saving = useRef(false);
  const workspaceRead = useRef<AbortController | null>(null);
  useEffect(() => () => {
    const abandoned = workspaceRead.current;
    if (abandoned) {
      workspaceRead.current = null;
      abandoned.abort();
      saving.current = false;
      setBusy(false);
    }
  }, [section]);
  const [baseline, setBaseline] = useState('');
  if (loadedSection !== section) { setLoadedSection(section); setEditor(null); setError(''); setConflict(false); setFieldErrors({}); }
  const dirty = editor !== null && baseline !== JSON.stringify([name, branchId, lectures]);
  const trigger = useRef<HTMLElement | null>(null);
  const manageable = context.branches.filter((branch) => context.permissions.can_manage_center || context.permissions.branch_actions?.[String(branch.id)]?.includes('curriculum.manage'));
  const branchName = (id: number) => context.branches.find((branch) => branch.id === id)?.name ?? `فرع رقم ${id}`;
  function open(next: Editor, preserveTrigger = false) {
    if (!preserveTrigger) trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const nextName = next.kind === 'plan' ? next.level.name : '';
    const nextBranch = manageable[0]?.id ?? 0;
    const nextLectures = next.kind === 'plan' ? next.level.plan.lectures.map(({ number, content, title, planned_hours }) => ({ number, content, title, planned_hours: String(planned_hours) })) : [blankLecture()];
    setBaseline(JSON.stringify([nextName, nextBranch, nextLectures]));
    setEditor(next); setName(nextName); setBranchId(nextBranch); setLectures(nextLectures);
    setRequestId(newSubmissionId()); setError(''); setNotice(''); setFieldErrors({}); setConflict(false);
  }
  async function editPlan(level: Level) {
    if (saving.current) return;
    const load = new AbortController();
    workspaceRead.current = load;
    const action = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    saving.current = true; setBusy(true); setError('');
    try {
      const response = await centerRequest(`levels/${level.id}`, 'GET', undefined, load.signal);
      if (!response.ok) {
        const message = await responseMessage(response);
        if (workspaceRead.current === load) setError(message);
        return;
      }
      const data = await response.json() as CurriculumContext;
      if (workspaceRead.current !== load) return;
      trigger.current = action;
      open({ kind: 'plan', level: data.levels[0] }, true);
    } catch { if (workspaceRead.current === load) setError('تعذر تحميل خطة المستوى. حاول مرة أخرى.'); }
    finally {
      if (workspaceRead.current === load) {
        workspaceRead.current = null; saving.current = false; setBusy(false);
      }
    }
  }
  function close() {
    setEditor(null); setError(''); setConflict(false);
    requestAnimationFrame(() => {
      if (trigger.current?.isConnected) trigger.current.focus();
      else if (editor) {
        const id = editor.kind === 'stage' ? editor.course.id : editor.kind === 'level' ? editor.stage.id : editor.kind === 'plan' ? editor.level.id : null;
        if (id) document.querySelector<HTMLElement>(`[data-curriculum-edit="${id}"]`)?.focus();
      }
    });
  }
  function changeLecture(index: number, change: Partial<LectureDraft>) {
    setLectures((items) => items.map((item, position) => position === index ? { ...item, ...change } : item)); setFieldErrors({});
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || saving.current) return;
    setError(''); setFieldErrors({}); setNotice('');
    const errors: Record<string, string> = {};
    if (editor.kind !== 'plan' && !name.trim()) errors.name = 'أدخل الاسم.';
    if (editor.kind === 'course' && !branchId) errors.branch_id = 'اختر فرعًا مصرحًا به.';
    if (editor.kind === 'level' || editor.kind === 'plan') for (const [index, lecture] of lectures.entries()) {
      if (!lecture.content.trim()) errors[`lectures.${index}.content`] = 'أدخل محتوى المحاضرة.';
      if (!lecture.planned_hours.trim() || !Number.isFinite(Number(lecture.planned_hours)) || Number(lecture.planned_hours) <= 0 || Number(lecture.planned_hours) > 9999.99 || !/^\d+(?:\.\d{1,2})?$/.test(lecture.planned_hours)) errors[`lectures.${index}.planned_hours`] = 'أدخل ساعات أكبر من صفر وبحد أقصى منزلتين عشريتين.';
    }
    if (Object.keys(errors).length) { setFieldErrors(errors); return; }
    saving.current = true; setBusy(true);
    try {
      const path = editor.kind === 'course' ? 'courses' : editor.kind === 'stage' ? `courses/${editor.course.id}/stages` : editor.kind === 'level' ? `stages/${editor.stage.id}/levels` : `levels/${editor.level.id}/first-plan`;
      const payload = editor.kind === 'plan' ? { plan_version_id: editor.level.plan.id, revision: editor.level.plan.revision } : { name: name.trim(), request_id: requestId, ...(editor.kind === 'course' ? { branch_id: branchId } : {}) };
      const response = await centerRequest(path, editor.kind === 'plan' ? 'PATCH' : 'POST', { ...payload, ...((editor.kind === 'level' || editor.kind === 'plan') ? { lectures: lectures.map((lecture, index) => ({ ...lecture, number: index + 1, content: lecture.content.trim(), title: lecture.title?.trim() || null, planned_hours: Number(lecture.planned_hours) })) } : {}) });
      if (!response.ok) {
        const data = await response.clone().json().catch(() => ({}));
        if (response.status === 409 && data.code === 'plan_used') setError('استُخدمت هذه الخطة؛ لا يمكن تغيير محتواها. التعديل الدراسي يحتاج إصدارًا لاحقًا مستقلًا.');
        else if (response.status === 409) { setConflict(true); setError('تغيّرت الخطة أو حُفظ الطلب سابقًا ببيانات مختلفة. حمّل البيانات الحالية قبل الحفظ.'); }
        else if (response.status === 404) setError('هذا السجل لم يعد متاحًا ضمن صلاحيتك.');
        else { setFieldErrors(await responseFieldErrors(response)); setError(await responseMessage(response)); }
        return;
      }
      close(); setNotice('حُفظ المنهج داخل الفرع مع هوية ثابتة لإصدار الخطة.');
      if (!detail && editor.kind !== 'plan') openSection(editor.kind === 'course' ? 'courses' : editor.kind === 'stage' ? 'stages' : 'levels');
      router.refresh();
    } catch { setError('تعذر تأكيد الحفظ. تحقق من الاتصال وأعد نفس الطلب؛ إعادة الإرسال لا تنشئ سجلًا مكررًا.'); }
    finally { saving.current = false; setBusy(false); }
  }
  async function recover() {
    if (!editor || saving.current) return;
    const load = new AbortController();
    workspaceRead.current = load;
    saving.current = true; setBusy(true);
    try {
      const response = await centerRequest(editor.kind === 'plan' ? `levels/${editor.level.id}` : `curriculum/submissions/${requestId}`, 'GET', undefined, load.signal);
      if (!response.ok) {
        const message = await responseMessage(response);
        if (workspaceRead.current === load) setError(message);
        return;
      }
      const data = await response.json() as CurriculumContext & { kind: string; record: Course | Stage | Level };
      if (workspaceRead.current !== load) return;
      if (editor.kind === 'plan') open({ kind: 'plan', level: data.levels[0] }, true);
      else {
        close(); setNotice('السجل حُفظ سابقًا. راجع السجل في الجدول؛ لن يُنشأ سجل آخر.');
        if (!detail) openSection(data.kind === 'stages' ? 'stages' : data.kind === 'levels' ? 'levels' : 'courses');
      }
      router.refresh();
    } catch { if (workspaceRead.current === load) setError('تعذر تحميل البيانات الحالية. حاول مرة أخرى.'); }
    finally {
      if (workspaceRead.current === load) {
        workspaceRead.current = null; saving.current = false; setBusy(false);
      }
    }
  }
  function batch(kind: keyof CurriculumContext['pagination']) {
    const current = context.pagination[kind];
    function href(page: number) { const params = new URLSearchParams({ tab: kind === 'branches' ? section : kind }); for (const [key, value] of Object.entries(context.pagination)) { const number = key === kind ? page : value.page; if (number > 1) params.set(`${key}_page`, String(number)); } return `/admin/curriculum${params.size ? `?${params}` : ''}`; }
    return <nav className='form-actions' aria-label={`دفعات ${{ courses: 'الكورسات', stages: 'المراحل الدراسية', levels: 'المستويات', branches: 'الفروع' }[kind]}`} key={kind}>{current.page > 1 ? <Link href={href(current.page - 1)}>الدفعة السابقة</Link> : null}<span>دفعة {current.page.toLocaleString('ar-EG')} · حتى ٥٠ سجلًا</span>{current.has_more ? <Link href={href(current.page + 1)}>الدفعة التالية</Link> : null}</nav>;
  }
  const editorForm = editor ? <form id={`${formPrefix}-0`} className='context-card form-stack' aria-label='إدارة منهج الفرع' noValidate onSubmit={save}>
<FieldGroup>
        <h2>{editor.kind === 'course' ? 'كورس جديد' : editor.kind === 'stage' ? `مرحلة دراسية في ${editor.course.name}` : editor.kind === 'level' ? `مستوى في ${editor.stage.name}` : `تعديل الخطة الأولى — ${editor.level.name}`}</h2>
        <FieldSet disabled={busy} className="form-stack" style={{ border: 0, padding: 0, margin: 0 }}>
          {editor.kind !== 'plan' ? <FormField id='curriculum-name' label={editor.kind === 'course' ? 'اسم الكورس' : editor.kind === 'stage' ? 'اسم المرحلة الدراسية' : 'اسم المستوى'} value={name} onChange={(value) => { setName(value); setFieldErrors({}); }} required error={fieldErrors.name} focusOnMount /> : null}
          {editor.kind === 'course' ? <FieldSet ><FieldLegend>الفرع الذي يملك الكورس</FieldLegend><Field data-invalid={Boolean(fieldErrors.branch_id)}><RadioGroup disabled={busy} aria-invalid={Boolean(fieldErrors.branch_id)} name='curriculum-branch' value={String(branchId)} onValueChange={(value) => setBranchId(Number(value))}>{manageable.map((branch) => <FieldLabel className="flex items-center gap-2" key={branch.id}><RadioGroupItem value={String(branch.id)} />{branch.name}</FieldLabel>)}</RadioGroup></Field>{fieldErrors.branch_id ? <p className='field-error' role='alert'>{fieldErrors.branch_id}</p> : null}</FieldSet> : null}
          {editor.kind === 'level' || editor.kind === 'plan' ? <>
            <p className='muted'>كل بند محاضرة مطلوبة كاملة. الترقيم متتابع، والعنوان اختياري، ولا تحتاج إلى تقسيم الموضوع. حتى ٢٠٠ محاضرة في الإصدار الأول.</p>
            {lectures.map((lecture, index) => <FieldSet className="form-stack" key={index}><FieldLegend>المحاضرة المطلوبة رقم {(index + 1).toLocaleString('ar-EG')}</FieldLegend>
              <FormField id={`lecture-content-${index}`} label={`محتوى المحاضرة ${index + 1}`} required focusOnMount={editor.kind === 'plan' && index === 0} value={lecture.content} onChange={(content) => changeLecture(index, { content })} error={fieldErrors[`lectures.${index}.content`]} />
              <FormField id={`lecture-title-${index}`} label={`عنوان المحاضرة ${index + 1} (اختياري)`} value={lecture.title ?? ''} onChange={(title) => changeLecture(index, { title })} error={fieldErrors[`lectures.${index}.title`]} />
              <FormField id={`lecture-hours-${index}`} label={`الساعات المخططة للمحاضرة ${index + 1}`} value={lecture.planned_hours} type='text' direction='ltr' onChange={(value) => changeLecture(index, { planned_hours: value })} error={fieldErrors[`lectures.${index}.planned_hours`]} hint='ساعات موجبة حتى منزلتين عشريتين. لا تستخدم لحساب نسبة الإتمام.' />
              {lectures.length > 1 ? <Button onClick={() => setLectures((items) => items.filter((_, number) => number !== index).map((item, number) => ({ ...item, number: number + 1 })))}>إزالة المحاضرة {index + 1}</Button> : null}
            </FieldSet>)}
            <Button disabled={lectures.length >= 200} onClick={() => setLectures((items) => [...items, { ...blankLecture(), number: items.length + 1 }])}>إضافة محاضرة كاملة</Button>
          </> : null}
<CenterHeaderActions>{conflict ? <Button onClick={recover}>تحميل البيانات الحالية للمنهج</Button> : null}<Button form={`${formPrefix}-0`} type='submit' variant='primary' busy={busy} disabled={conflict}>حفظ المنهج</Button><Button disabled={busy} onClick={close}>إلغاء</Button></CenterHeaderActions>
        </FieldSet>
      </FieldGroup>
</form> : null;
  const courses = <>        <DataTable id='curriculum-courses' title='الكورسات' description='المناهج المتاحة في الفروع المصرح بها. البحث والتصفية ضمن الدفعة المعروضة.' rows={context.courses} rowKey={(row) => row.id} searchText={(row) => `${row.name} ${branchName(row.branch_id)}`} emptyMessage='لا توجد كورسات متاحة. أنشئ كورسًا إذا كانت لديك صلاحية الإدارة الأكاديمية.' columns={[
          { key: 'name', label: 'الكورس', filterText: (row) => row.name, render: (row) => <h3>{row.name}</h3> },
          { key: 'branch', label: 'الفرع', filterText: (row) => branchName(row.branch_id), render: (row) => branchName(row.branch_id) },
          { key: 'actions', label: 'الإجراءات', actions: true, render: (row) => row.can_manage ? <Button data-curriculum-edit={row.id} disabled={busy || editor !== null} onClick={() => open({ kind: 'stage', course: row })}>إضافة مرحلة دراسية</Button> : 'عرض فقط' },
        ]} />{batch('courses')}
</>;
  const stages = <>        <DataTable id='curriculum-stages' title='المراحل الدراسية' rows={context.stages} rowKey={(row) => row.id} searchText={(row) => `${row.name} ${row.course_name}`} emptyMessage='لا توجد مراحل دراسية متاحة. أضف مرحلة من الكورس.' columns={[
          { key: 'name', label: 'المرحلة الدراسية', filterText: (row) => row.name, render: (row) => <h3>{row.name}</h3> },
          { key: 'course', label: 'الكورس والفرع', filterText: (row) => `${row.course_name} ${branchName(row.branch_id)}`, render: (row) => `${row.course_name} · ${branchName(row.branch_id)}` },
          { key: 'actions', label: 'الإجراءات', actions: true, render: (row) => row.can_manage ? <Button data-curriculum-edit={row.id} disabled={busy || editor !== null} onClick={() => open({ kind: 'level', stage: row })}>إضافة مستوى وخطته</Button> : 'عرض فقط' },
        ]} />{batch('stages')}
</>;
  const levels = <>      <DataTable id='curriculum-levels' title='المستويات وخططها' rows={context.levels} rowKey={(row) => row.id} searchText={(row) => `${row.name} ${row.stage_name} ${row.course_name}`} emptyMessage='لا توجد مستويات متاحة. أضف مستوى وخطته من المرحلة الدراسية.' columns={[
        { key: 'name', label: 'المستوى', filterText: (row) => row.name, render: (row) => <Link href={`/admin/curriculum/${row.id}`}>{row.name}</Link> },
        { key: 'sequence', label: 'الكورس والمرحلة والفرع', filterText: (row) => `${row.course_name} ${row.stage_name} ${branchName(row.branch_id)}`, render: (row) => `${row.course_name} ← ${row.stage_name} · ${branchName(row.branch_id)}` },
        { key: 'plan', label: 'الخطة الأولى', render: (row) => `${row.plan.lecture_count.toLocaleString('ar-EG')} محاضرة مطلوبة · ${row.plan.planned_hours.toLocaleString('ar-EG')} ساعة مخططة` },
        { key: 'status', label: 'حالة الخطة', render: (row) => row.plan.used_at ? 'مستخدمة — محتوى ثابت' : 'لم تستخدم بعد' },
        { key: 'actions', label: 'الإجراءات', actions: true, render: (row) => row.can_manage && !row.plan.used_at ? <Button data-curriculum-edit={row.id} disabled={busy || editor !== null} onClick={() => editPlan(row)}>تعديل الخطة الأولى</Button> : <span className='muted'>{row.plan.used_at ? 'التعديل يحتاج إصدارًا جديدًا' : 'عرض فقط'}</span> },
      ]} />{!detail ? batch('levels') : null}
</>;
  const branchChoices = <>      {!detail && (context.pagination.branches.has_more || context.pagination.branches.page > 1) ? <section className='context-card'><p>فروع إنشاء الكورس في هذه الدفعة.</p>{batch('branches')}</section> : null}
</>;
  return <>
    <CenterPageActions context={context} actions={!detail && manageable.length ? <Button hidden={editor !== null} variant='primary' disabled={busy || editor !== null} onClick={() => open({ kind: 'course' })}>إنشاء كورس</Button> : undefined} />
      <UnsavedChangesGuard dirty={dirty} guardHistory />
      {busy && !editor ? <InlineNotice>جارٍ تحميل خطة المستوى الحالية…</InlineNotice> : null}
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}{error ? <InlineNotice tone='error'>{error}</InlineNotice> : null}
      {detail ? <Link href='/admin/curriculum'>العودة إلى منهج الفرع</Link> : null}
      {detail ? editorForm : null}
      {detail ? levels : <WorkspaceSections value={section} label='أقسام منهج الفرع' path='/admin/curriculum' sections={[
        { value: 'courses', label: 'الكورسات', content: <>{editorForm}<div hidden={Boolean(editor)} className='workspace-register'>{courses}{branchChoices}</div></> },
        { value: 'stages', label: 'المراحل الدراسية', content: <>{editorForm}<div hidden={Boolean(editor)} className='workspace-register'>{stages}</div></> },
        { value: 'levels', label: 'المستويات وخططها', content: <>{editorForm}<div hidden={Boolean(editor)} className='workspace-register'>{levels}</div></> },
      ]} />}
      {detail && context.levels[0] ? <DataTable id='curriculum-lectures' title='المحاضرات المطلوبة' description={`الإصدار الأول؛ ${context.levels[0].plan.lectures.length.toLocaleString('ar-EG')} محاضرة كاملة. هذه متطلبات الخطة وليست سجل المحاضرات الفعلية.`} rows={context.levels[0].plan.lectures} rowKey={(row) => row.number} searchText={(row) => `${row.number} ${row.content} ${row.title ?? ''}`} emptyMessage='لا توجد محاضرات مطلوبة.' columns={[
        { key: 'number', label: 'رقم المحاضرة', render: (row) => row.number.toLocaleString('ar-EG') },
        { key: 'content', label: 'المحتوى المطلوب', filterText: (row) => row.content, render: (row) => row.content },
        { key: 'title', label: 'العنوان الاختياري', filterText: (row) => row.title ?? '', render: (row) => row.title || 'بدون عنوان' },
        { key: 'hours', label: 'الساعات المخططة', render: (row) => row.planned_hours.toLocaleString('ar-EG') },
      ]} /> : null}
  </>;
}
