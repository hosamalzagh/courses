'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { PrefetchLink as Link } from '@/components/PrefetchLink';
import { UnsavedChangesGuard } from '@/components/UnsavedChangesGuard';
import { CenterPageActions } from '@/components/CenterShell';
import { Button } from '@/components/Button';
import { FormField } from '@/components/FormField';
import { InlineNotice } from '@/components/InlineNotice';
import { centerRequest, newSubmissionId, responseFieldErrors, responseMessage } from '@/lib/client-api';
import type { Student, StudentContext, StudentGeneralData } from '@/lib/server-context';

type SimilarStudent = Pick<Student, 'id' | 'student_number' | 'name' | 'phone'> & { within_scope?: boolean };

export function StudentForm({ context, student }: { context: StudentContext; student?: Student }) {
  const router = useRouter();
  const manageable = context.branches.filter((branch) => context.permissions.can_manage_center || (context.permissions.branch_actions?.[String(branch.id)] ?? []).includes('students.manage'));
  const [editor, setEditor] = useState<Student | 'new'>(student ?? 'new');
  const [name, setName] = useState(student?.name ?? '');
  const [phone, setPhone] = useState(student?.phone ?? '');
  const [branchIds, setBranchIds] = useState<number[]>(student?.branch_ids.filter((id) => manageable.some((branch) => branch.id === id)) ?? manageable.slice(0, 1).map((branch) => branch.id));
  const [requestId, setRequestId] = useState(newSubmissionId);
  const [general, setGeneral] = useState<StudentGeneralData>(profileData(student));
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [similar, setSimilar] = useState<SimilarStudent[]>([]);
  const [reviewed, setReviewed] = useState('');
  const [conflict, setConflict] = useState(false);

  const initialBranches = editor === 'new' ? manageable.slice(0, 1).map((branch) => branch.id) : editor ? editor.branch_ids.filter((id) => manageable.some((branch) => branch.id === id)) : [];
  const dirty = !saved && (name !== (editor === 'new' ? '' : editor.name) || phone !== (editor === 'new' ? '' : editor.phone ?? '') || JSON.stringify([...branchIds].sort()) !== JSON.stringify([...initialBranches].sort()) || JSON.stringify(general) !== JSON.stringify(profileData(editor === 'new' ? undefined : editor)));

  function open(student: Student) {
    setSaved(false);
    setGeneral(profileData(student));
    setEditor(student); setName(student.name); setPhone(student.phone ?? '');
    setBranchIds(student.branch_ids.filter((id) => manageable.some((branch) => branch.id === id)));
    setRequestId(newSubmissionId()); setError(''); setFieldErrors({}); setNotice(''); setSimilar([]); setReviewed(''); setConflict(false);
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
        const matches = (await response.json()).students as SimilarStudent[];
        setSimilar(matches); setReviewed(fingerprint);
        if (matches.length) return;
      }
      const response = await centerRequest(editor === 'new' ? 'students' : `students/${editor.id}`, editor === 'new' ? 'POST' : 'PATCH', {
        name: name.trim(), phone: phone.trim() || null, branch_ids: branchIds, ...general,
        ...(editor === 'new' ? { request_id: requestId } : { revision: editor.revision }),
      });
      if (!response.ok) {
        if (response.status === 409 && (await response.clone().json().catch(() => ({}))).code !== 'student_numbering_exhausted') {
          setConflict(true);
          setError('تغيّرت بيانات الملف أو الطلب. راجع أحدث بيانات الطالب قبل إعادة الحفظ.');
        } else if (response.status === 404) {
          setError('ملف الطالب لم يعد متاحًا ضمن صلاحيتك. راجع مسؤول المركز.');
        } else {
          setFieldErrors(await responseFieldErrors(response)); setError(await responseMessage(response));
        }
        return;
      }
      const data = await response.json() as { student: Student };
      open(data.student);
      setSaved(true);
      router.push(`/admin/students/${data.student.id}?focus=edit`);
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
      open(wasNew ? data.student! : data.students[0]);
      if (wasNew) setNotice('الملف حُفظ سابقًا. راجع بياناته قبل تعديلها؛ لن يُنشأ ملف آخر.');
      requestAnimationFrame(() => document.getElementById('student-name')?.focus());
    } catch { setError('تعذر تحميل أحدث البيانات. حاول مرة أخرى.'); }
    finally { setBusy(false); }
  }

  function changeGeneral(field: keyof StudentGeneralData, value: string) {
    setSaved(false);
    setGeneral((data) => ({ ...data, [field]: value || null }));
    setFieldErrors((errors) => ({ ...errors, [field]: '' }));
  }

  return <>
    <CenterPageActions context={context} />
    <UnsavedChangesGuard dirty={dirty} guardHistory />
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {error ? <InlineNotice tone='error'>{error}</InlineNotice> : null}
      <form className='context-card form-stack' aria-label={editor === 'new' ? 'ملف طالب جديد' : `تعديل ملف ${editor.name}`} noValidate onSubmit={save}>

        <fieldset disabled={busy} className='form-stack' style={{ border: 0, padding: 0, margin: 0 }}>
        <h2>البيانات الشخصية</h2>
        <div className='student-fields'>
        <FormField id='student-name' label='اسم الطالب' focusOnMount value={name} onChange={(value) => { setSaved(false); setName(value); setFieldErrors({}); setSimilar([]); }} error={fieldErrors.name} required autoComplete='off' />
        <FormField id='student-date_of_birth' label='تاريخ الميلاد' value={general.date_of_birth ?? ''} onChange={(value) => changeGeneral('date_of_birth', value)} error={fieldErrors.date_of_birth} direction='ltr' hint='اختياري بصيغة YYYY-MM-DD. العمر يُحسب تلقائيًا من التاريخ.' />
        <fieldset className='branch-grants'><legend>النوع (اختياري)</legend>{[['', 'غير محدد'], ['male', 'ذكر'], ['female', 'أنثى']].map(([value, label]) => <label className='check-row' key={value}><input type='radio' name='student-gender' value={value} checked={(general.gender ?? '') === value} onChange={() => changeGeneral('gender', value)} />{label}</label>)}{fieldErrors.gender ? <p className='field-error' role='alert'>{fieldErrors.gender}</p> : null}</fieldset>
        <FormField id='student-address' label='العنوان' value={general.address ?? ''} onChange={(value) => changeGeneral('address', value)} error={fieldErrors.address} autoComplete='street-address' />
        </div>
        <h2>التواصل</h2><div className='student-fields'>
        <FormField id='student-email' label='البريد الإلكتروني' type='email' direction='ltr' value={general.email ?? ''} onChange={(value) => changeGeneral('email', value)} error={fieldErrors.email} autoComplete='email' />
        <FormField id='student-phone' label='رقم التواصل' value={phone} onChange={(value) => { setSaved(false); setPhone(value); setFieldErrors({}); setSimilar([]); }} error={fieldErrors.phone} type='tel' direction='ltr' autoComplete='off' hint='اختياري، ويمكن لأكثر من طالب استخدام نفس الرقم.' />
        </div><h2>خلفية الدراسة والعمل</h2><div className='student-fields'>
        {([['school', 'المدرسة / جهة الدراسة'], ['employer', 'جهة العمل'], ['specialization', 'التخصص']] as const).map(([key, label]) => <FormField key={key} id={`student-${key}`} label={label} value={general[key] ?? ''} onChange={(value) => changeGeneral(key, value)} error={fieldErrors[key]} />)}
        </div>
        <fieldset className='branch-grants' aria-describedby={fieldErrors.branch_ids ? 'student-branches-error' : 'student-branches-hint'}><legend>الفروع المرتبطة بالطالب</legend>
          <p id='student-branches-hint' className='muted'>اختر فروع التسجيل المصرح بها. تبقى ارتباطات الملف السابقة محفوظة.</p>
          {manageable.map((branch) => {
            const associated = editor !== 'new' && editor.branch_ids.includes(branch.id);
            return <label key={branch.id} className='check-row'><input type='checkbox' checked={branchIds.includes(branch.id)} disabled={busy || associated} onChange={(event) => { setSaved(false); setBranchIds((ids) => event.target.checked ? [...ids, branch.id] : ids.filter((id) => id !== branch.id)); setFieldErrors({}); }} />{branch.name}{associated ? ' — مرتبط بالفعل' : ''}</label>;
          })}
          {fieldErrors.branch_ids ? <p id='student-branches-error' className='field-error' role='alert'>{fieldErrors.branch_ids}</p> : null}
        </fieldset>
        {similar.length ? <InlineNotice tone='warning'><strong>توجد ملفات ببيانات متشابهة ضمن نطاق صلاحيتك.</strong><p>راجع الملف المتاح ضمن فروعك لإعادة استخدامه. البيانات الأساسية خارج فروعك لا تمنح تعديل الملف؛ تواصل مع مسؤول المركز عند الحاجة. يمكنك حفظ ملف مستقل إذا كان طالبًا آخر؛ لا تُدمج الملفات تلقائيًا.</p><ul>{similar.map((student) => <li key={student.id}>{student.within_scope === false ? <span>{student.name} — رقم {student.student_number.toLocaleString('ar-EG')} · بيانات أساسية خارج فروعك</span> : <Link href={`/admin/students/${student.id}`}>{student.name} — رقم {student.student_number.toLocaleString('ar-EG')}</Link>}{student.phone ? <bdi> · {student.phone}</bdi> : null}</li>)}</ul></InlineNotice> : null}
        {conflict ? <Button disabled={busy} onClick={reloadStudent}>تحميل أحدث بيانات الطالب</Button> : null}
        <div className='form-actions'><Button type='submit' variant='primary' busy={busy} disabled={conflict}>{similar.length && editor === 'new' ? 'إنشاء ملف مستقل' : editor === 'new' ? 'حفظ ملف الطالب' : 'حفظ بيانات الطالب'}</Button><Link href={editor === 'new' ? '/admin/students?focus=create' : `/admin/students/${editor.id}?focus=edit`}>إلغاء</Link></div>
        </fieldset>
      </form>
  </>;
}

function profileData(student?: Student): StudentGeneralData {
  return { date_of_birth: student?.date_of_birth ?? null, gender: student?.gender ?? null, address: student?.address ?? null,
    email: student?.email ?? null, school: student?.school ?? null, employer: student?.employer ?? null, specialization: student?.specialization ?? null };
}
