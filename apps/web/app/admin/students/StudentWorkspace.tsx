'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CenterShell } from '@/components/CenterShell';
import { DataTable } from '@/components/DataTable';
import { Button } from '@/components/Button';
import { FormField } from '@/components/FormField';
import { InlineNotice } from '@/components/InlineNotice';
import { centerRequest, newSubmissionId, responseFieldErrors, responseMessage } from '@/lib/client-api';
import type { Student, StudentContext } from '@/lib/server-context';

export function StudentWorkspace({ context, query, detail = false }: { context: StudentContext; query: string; detail?: boolean }) {
  const router = useRouter();
  const [editor, setEditor] = useState<Student | 'new' | null>(null);
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
  const [similar, setSimilar] = useState<Student[]>([]);
  const [reviewed, setReviewed] = useState('');
  const [conflict, setConflict] = useState(false);
  const manageable = context.branches.filter((branch) => context.permissions.can_manage_center || (context.permissions.branch_actions?.[String(branch.id)] ?? []).includes('students.manage'));

  function open(student: Student | 'new', preserveTrigger = false) {
    if (!preserveTrigger) trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditor(student); setName(student === 'new' ? '' : student.name); setPhone(student === 'new' ? '' : student.phone ?? '');
    setBranchIds(student === 'new' ? manageable.slice(0, 1).map((branch) => branch.id) : student.branch_ids.filter((id) => manageable.some((branch) => branch.id === id)));
    setRequestId(newSubmissionId()); setError(''); setFieldErrors({}); setNotice(''); setSimilar([]); setReviewed(''); setConflict(false);
  }

  function close() {
    setEditor(null); setSimilar([]); setError('');
    requestAnimationFrame(() => trigger.current?.isConnected && trigger.current.focus());
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || saving.current) return;
    setError(''); setFieldErrors({}); setNotice('');
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = 'أدخل اسم الطالب.';
    if (editor === 'new' && !branchIds.length) errors.branch_ids = 'اختر فرعًا مصرحًا به على الأقل.';
    if (Object.keys(errors).length) { setFieldErrors(errors); return; }
    saving.current = true; setBusy(true);
    try {
      const fingerprint = JSON.stringify([name.trim(), phone.trim()]);
      if (reviewed !== fingerprint) {
        const params = new URLSearchParams({ name: name.trim(), phone: phone.trim() });
        if (editor !== 'new') params.set('exclude', editor.id);
        const response = await centerRequest(`students/similar?${params}`, 'GET');
        if (!response.ok) { setError(await responseMessage(response)); return; }
        const matches = (await response.json()).students as Student[];
        setSimilar(matches); setReviewed(fingerprint);
        if (matches.length) return;
      }
      const response = await centerRequest(editor === 'new' ? 'students' : `students/${editor.id}`, editor === 'new' ? 'POST' : 'PATCH', {
        name: name.trim(), phone: phone.trim() || null, branch_ids: branchIds,
        ...(editor === 'new' ? { request_id: requestId } : { revision: editor.revision }),
      });
      if (!response.ok) {
        if (response.status === 409) {
          setConflict(true);
          setError('تغيّرت بيانات الملف أو الطلب. راجع أحدث بيانات الطالب قبل إعادة الحفظ.');
        } else if (response.status === 404) {
          setError('ملف الطالب لم يعد متاحًا ضمن صلاحيتك. راجع مسؤول المركز.');
        } else {
          setFieldErrors(await responseFieldErrors(response)); setError(await responseMessage(response));
        }
        return;
      }
      const created = editor === 'new';
      close(); setNotice(created ? 'أُنشئ ملف الطالب برقم داخلي مستقل.' : 'حُفظت بيانات الطالب والفروع المرتبطة به.');
      router.refresh();
    } catch { setError('تعذر حفظ الملف. تحقق من الاتصال وأعد المحاولة؛ إعادة الطلب لا تنشئ ملفًا مكررًا.'); }
    finally { saving.current = false; setBusy(false); }
  }

  async function reloadStudent() {
    if (!editor) return;
    setBusy(true);
    try {
      const response = await centerRequest(editor === 'new' ? `students/submissions/${requestId}` : `students/${editor.id}`, 'GET');
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const data = await response.json() as StudentContext & { student?: Student };
      const wasNew = editor === 'new';
      open(wasNew ? data.student! : data.students[0], true);
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
    return `/admin/students${params.size ? `?${params}` : ''}`;
  }

  return <CenterShell context={context} title='ملفات الطلاب' description='ملف واحد داخل المركز، دون حساب دخول. رقم الطالب ثابت ورقم التواصل يمكن مشاركته.' actions={manageable.length && !detail ? <Button variant='primary' disabled={busy} onClick={() => open('new')}>إنشاء ملف طالب</Button> : undefined}>
    <main className='members-main'>
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      {error ? <InlineNotice tone='error'>{error}</InlineNotice> : null}
      {detail ? <Link prefetch={false} href='/admin/students'>العودة إلى ملفات الطلاب</Link> : <form className='context-card form-stack' noValidate onSubmit={(event) => { event.preventDefault(); router.push(`/admin/students?${new URLSearchParams({ q: search })}`); }} aria-label='البحث في جميع ملفات الطلاب'>
        <FormField id='student-global-search' label='البحث في جميع الملفات المصرح بها' value={search} onChange={setSearch} hint='الاسم أو رقم الطالب الداخلي أو رقم التواصل. لا يشمل الفروع المحجوبة.' />
        <div className='form-actions'><Button type='submit' variant='primary' disabled={busy}>بحث عن طالب</Button>{query ? <Link prefetch={false} href='/admin/students'>مسح البحث</Link> : null}</div>
      </form>}
      {editor ? <form className='context-card form-stack' aria-label={editor === 'new' ? 'ملف طالب جديد' : `تعديل ملف ${editor.name}`} noValidate onSubmit={save}>
        <h2>{editor === 'new' ? 'ملف طالب جديد' : `تعديل ملف الطالب رقم ${editor.student_number.toLocaleString('ar-EG')}`}</h2>
        <fieldset disabled={busy} className='form-stack' style={{ border: 0, padding: 0, margin: 0 }}>
        <FormField id='student-name' label='اسم الطالب' focusOnMount value={name} onChange={(value) => { setName(value); setFieldErrors({}); setSimilar([]); }} error={fieldErrors.name} required autoComplete='off' />
        <FormField id='student-phone' label='رقم التواصل' value={phone} onChange={(value) => { setPhone(value); setFieldErrors({}); setSimilar([]); }} error={fieldErrors.phone} type='tel' direction='ltr' autoComplete='off' hint='اختياري، ويمكن لأكثر من طالب استخدام نفس الرقم.' />
        <fieldset className='branch-grants' aria-describedby={fieldErrors.branch_ids ? 'student-branches-error' : 'student-branches-hint'}><legend>الفروع المرتبطة بالطالب</legend>
          <p id='student-branches-hint' className='muted'>اختر فروع التسجيل المصرح بها. تبقى ارتباطات الملف السابقة محفوظة.</p>
          {manageable.map((branch) => {
            const associated = editor !== 'new' && editor.branch_ids.includes(branch.id);
            return <label key={branch.id} className='check-row'><input type='checkbox' checked={branchIds.includes(branch.id)} disabled={busy || associated} onChange={(event) => { setBranchIds((ids) => event.target.checked ? [...ids, branch.id] : ids.filter((id) => id !== branch.id)); setFieldErrors({}); }} />{branch.name}{associated ? ' — مرتبط بالفعل' : ''}</label>;
          })}
          {fieldErrors.branch_ids ? <p id='student-branches-error' className='field-error' role='alert'>{fieldErrors.branch_ids}</p> : null}
        </fieldset>
        {similar.length ? <InlineNotice tone='warning'><strong>توجد ملفات ببيانات متشابهة ضمن نطاق صلاحيتك.</strong><p>راجع الملف الموجود لإعادة استخدامه، أو احفظ ملفًا مستقلًا إذا كان طالبًا آخر. لا تُدمج الملفات تلقائيًا.</p><ul>{similar.map((student) => <li key={student.id}><a href={`/admin/students/${student.id}`}>{student.name} — رقم {student.student_number.toLocaleString('ar-EG')}</a>{student.phone ? <bdi> · {student.phone}</bdi> : null}</li>)}</ul></InlineNotice> : null}
        {conflict ? <Button disabled={busy} onClick={reloadStudent}>تحميل أحدث بيانات الطالب</Button> : null}
        <div className='form-actions'><Button type='submit' variant='primary' busy={busy} disabled={conflict}>{similar.length && editor === 'new' ? 'إنشاء ملف مستقل' : editor === 'new' ? 'حفظ ملف الطالب' : 'حفظ بيانات الطالب'}</Button><Button disabled={busy} onClick={close}>إلغاء</Button></div>
        </fieldset>
      </form> : null}
      {!editor && (context.pagination.branches_has_more || context.pagination.branches_page > 1) ? <nav className='form-actions' aria-label='صفحات فروع الطلاب'>{context.pagination.branches_page > 1 ? <a href={pageLink(context.pagination.page, context.pagination.branches_page - 1)}>الفروع السابقة</a> : null}<span>صفحة الفروع {context.pagination.branches_page.toLocaleString('ar-EG')}</span>{context.pagination.branches_has_more ? <a href={pageLink(context.pagination.page, context.pagination.branches_page + 1)}>الفروع التالية</a> : null}</nav> : null}
      <DataTable id='students' title='سجل الطلاب' description={detail ? 'البيانات الأساسية للملف ضمن الفروع المصرح بها.' : 'تصفية الجدول ضمن هذه الدفعة (حتى ٥٠ ملفًا). استخدم البحث أعلاه للبحث في جميع الملفات المصرح بها.'} rows={context.students} rowKey={(student) => student.id} searchText={(student) => `${student.student_number} ${student.name} ${student.phone ?? ''}`} emptyMessage={query ? 'لا يوجد طالب مطابق ضمن نطاق صلاحيتك.' : 'لا توجد ملفات طلاب متاحة. أنشئ ملفًا إذا كانت لديك صلاحية التسجيل.'}
        columns={[
          { key: 'number', label: 'رقم الطالب الداخلي', filterText: (student) => String(student.student_number), render: (student) => <a className='table-code' href={`/admin/students/${student.id}`}>{student.student_number.toLocaleString('ar-EG')}</a> },
          { key: 'name', label: 'الطالب', filterText: (student) => student.name, render: (student) => <h3>{student.name}</h3> },
          { key: 'phone', label: 'رقم التواصل', filterText: (student) => student.phone ?? '', render: (student) => <bdi dir='ltr'>{student.phone || 'لم يُضف رقم تواصل'}</bdi> },
          { key: 'branches', label: 'الفروع المصرح بها', filterText: (student) => student.branch_ids.map((id) => context.branches.find((branch) => branch.id === id)?.name ?? `فرع رقم ${id}`).join('، '), render: (student) => student.branch_ids.map((id) => context.branches.find((branch) => branch.id === id)?.name ?? `فرع رقم ${id}`).join('، ') },
          { key: 'actions', label: 'الإجراءات', actions: true, render: (student) => student.can_manage ? <Button disabled={busy} onClick={() => open(student)}>تعديل ملف الطالب</Button> : <span className='muted'>صلاحية عرض فقط</span> },
        ]} />
      {!detail ? <nav className='form-actions' aria-label='دفعات ملفات الطلاب'>{context.pagination.page > 1 ? <a href={pageLink(context.pagination.page - 1)}>دفعة الملفات السابقة</a> : null}<span>دفعة {context.pagination.page.toLocaleString('ar-EG')}</span>{context.pagination.has_more ? <a href={pageLink(context.pagination.page + 1)}>دفعة الملفات التالية</a> : null}</nav> : null}
    </main>
  </CenterShell>;
}
