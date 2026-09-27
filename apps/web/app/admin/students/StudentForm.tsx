'use client';

import { useId } from "react";

import { Field } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldGroup, FieldSet, FieldLegend, FieldLabel } from "@/components/ui/field";


import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { PrefetchLink as Link } from '@/components/PrefetchLink';
import { UnsavedChangesGuard } from '@/components/UnsavedChangesGuard';
import { buttonVariants } from "@/components/ui/button";
import { CenterPageActions, CenterHeaderActions } from '@/components/CenterShell';
import { Button } from '@/components/Button';
import { StudentCustomFields } from '@/components/StudentCustomFields';
import { customFieldErrors } from '@/lib/student-custom-fields';
import { StudentIdentityFields } from '@/components/StudentIdentityFields';
import { StudentContactFields } from '@/components/StudentContactFields';
import { studentContactsData, contactValidation } from '@/lib/student-contacts';
import { StudentChoiceFields } from '@/components/StudentChoiceFields';
import { FormField } from '@/components/FormField';
import { InlineNotice } from '@/components/InlineNotice';
import { centerRequest, newSubmissionId, responseFieldErrors, responseMessage } from '@/lib/client-api';
import type { Student, StudentContext, StudentGeneralData, StudentIdentityData, StudentCustomValues } from '@/lib/server-context';

type SimilarStudent = Pick<Student, 'id' | 'student_number' | 'name' | 'phone'> & { within_scope?: boolean };

export function StudentForm({ context, student }: { context: StudentContext; student?: Student }) {
  const formPrefix = useId();
  const router = useRouter();
  const [branches, setBranches] = useState(context.branches);
  const [branchPage, setBranchPage] = useState(context.pagination.branches_page);
  const [hasMoreBranches, setHasMoreBranches] = useState(context.pagination.branches_has_more);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const loadingBranchPage = useRef(false);
  const manageable = branches.filter((branch) => context.permissions.can_manage_center || (context.permissions.branch_actions?.[String(branch.id)] ?? []).includes('students.manage'));
  const [editor, setEditor] = useState<Student | 'new'>(student ?? 'new');
  const [name, setName] = useState(student?.name ?? '');
  const [manualCode, setManualCode] = useState(student?.manual_code ?? '');
  const [phone, setPhone] = useState(student?.legacy_phone ?? '');
  const [branchIds, setBranchIds] = useState<number[]>(student?.branch_ids.filter((id) => manageable.some((branch) => branch.id === id)) ?? manageable.slice(0, 1).map((branch) => branch.id));
  const [requestId, setRequestId] = useState(newSubmissionId);
  const [general, setGeneral] = useState<StudentGeneralData>(profileData(student));
  const [contactData, setContactData] = useState(() => studentContactsData(student));
  const [identity, setIdentity] = useState<StudentIdentityData>(student?.identity ?? {national_id:null,passport_number:null});
  const [customFields,setCustomFields]=useState(context.custom_fields);
  const [customValues,setCustomValues]=useState<StudentCustomValues>(student?.custom_values ?? {});
  const [customBaseline,setCustomBaseline]=useState<StudentCustomValues>(student?.custom_values ?? {});
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
  const canManageIdentity = editor === 'new' ? branchIds.some(id => context.permissions.can_manage_center || (context.permissions.branch_actions?.[String(id)] ?? []).includes('students.identity')) : editor.can_manage_identity;
  const canReadIdentity = editor === 'new' ? canManageIdentity : editor.can_read_identity;
  const dirty = !saved && (Object.keys(customValues).some(id=>(customValues[id] ?? null) !== (customBaseline[id] ?? null)) || JSON.stringify(identity) !== JSON.stringify(editor === 'new' ? {national_id:null,passport_number:null} : editor.identity ?? {national_id:null,passport_number:null}) || manualCode !== (editor === 'new' ? '' : editor.manual_code ?? '') || name !== (editor === 'new' ? '' : editor.name) || phone !== (editor === 'new' ? '' : editor.legacy_phone ?? '') || JSON.stringify([...branchIds].sort()) !== JSON.stringify([...initialBranches].sort()) || JSON.stringify(general) !== JSON.stringify(profileData(editor === 'new' ? undefined : editor)) || JSON.stringify(contactData) !== JSON.stringify(studentContactsData(editor === 'new' ? undefined : editor)));

  function open(student: Student) {
    setSaved(false);
    setGeneral(profileData(student));
    setCustomValues(student.custom_values ?? {});setCustomBaseline(student.custom_values ?? {});
    setIdentity(student.identity ?? {national_id:null,passport_number:null});
    setManualCode(student.manual_code ?? '');
    setContactData(studentContactsData(student));
    setEditor(student); setName(student.name); setPhone(student.legacy_phone ?? '');
    setBranchIds(student.branch_ids.filter((id) => manageable.some((branch) => branch.id === id)));
    setRequestId(newSubmissionId()); setError(''); setFieldErrors({}); setNotice(''); setSimilar([]); setReviewed(''); setConflict(false);
  }

  async function loadMoreBranches() {
    if (loadingBranchPage.current || !hasMoreBranches) return;
    loadingBranchPage.current = true; setLoadingBranches(true); setError('');
    try {
      const response = await centerRequest(`student-workspace?branches_page=${branchPage + 1}`, 'GET');
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const data = await response.json() as StudentContext;
      setBranches((current) => [...current, ...data.branches.filter((branch) => !current.some((existing) => existing.id === branch.id))]);
      if (editor !== 'new') {
        const associated = data.branches.filter((branch) => editor.branch_ids.includes(branch.id) && (context.permissions.can_manage_center || (context.permissions.branch_actions?.[String(branch.id)] ?? []).includes('students.manage'))).map((branch) => branch.id);
        setBranchIds((current) => [...new Set([...current, ...associated])]);
      }
      setBranchPage(data.pagination.branches_page); setHasMoreBranches(data.pagination.branches_has_more);
    } catch { setError('تعذر تحميل بقية الفروع. مدخلات الملف محفوظة؛ أعد المحاولة.'); }
    finally { loadingBranchPage.current = false; setLoadingBranches(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || saving.current) return;
    setError(''); setFieldErrors({}); setNotice('');
    const errors: Record<string, string> = {...contactValidation(contactData),...customFieldErrors(customFields.fields.filter(field=>field.classification !== 'identity' || canReadIdentity),customValues)};
    if (!name.trim()) errors.name = 'أدخل اسم الطالب.';
    if (editor === 'new' && !branchIds.length) errors.branch_ids = 'اختر فرعًا مصرحًا به على الأقل.';
    if (Object.keys(errors).length) { setFieldErrors(errors); return; }
    saving.current = true; setBusy(true);
    try {
      const fingerprint = JSON.stringify([name.trim(), phone.trim(), contactData]);
      if (reviewed !== fingerprint) {
        const params = new URLSearchParams({ name: name.trim(), phone: phone.trim() });
        const phones = [...contactData.contacts.map(contact => contact.phone), ...Object.values(contactData.channels).filter(channel => channel !== null).map(channel => channel.phone)];
        for (const number of new Set(phones.filter(number => number.trim()))) params.append('phones[]', number.trim());
        if (editor !== 'new') params.set('exclude', editor.id);
        const response = await centerRequest(`students/similar?${params}`, 'GET');
        if (!response.ok) { setError(await responseMessage(response)); return; }
        const matches = (await response.json()).students as SimilarStudent[];
        setSimilar(matches); setReviewed(fingerprint);
        if (matches.length) return;
      }
      const response = await centerRequest(editor === 'new' ? 'students' : `students/${editor.id}`, editor === 'new' ? 'POST' : 'PATCH', {
        custom_values:Object.fromEntries(Object.entries(customValues).filter(([id])=>canManageIdentity || !customFields.fields.some(field=>field.id === id && field.classification === 'identity'))), custom_fields_revision:customFields.revision, name: name.trim(), phone: phone.trim() || null, branch_ids: editor === 'new' ? branchIds : branchIds.filter((id) => !editor.branch_ids.includes(id)), ...general, ...contactData, ...(canManageIdentity ? identity : {}), ...(context.student_code_settings.enabled ? {manual_code:manualCode.trim() || null} : {}),
        ...(editor === 'new' ? { request_id: requestId } : { revision: editor.revision }),
      });
      if (!response.ok) {
        if (response.status === 409 && !['student_numbering_exhausted','student_number_code_collision'].includes((await response.clone().json().catch(() => ({}))).code)) {
          if ((await response.clone().json().catch(()=>({}))).code === 'student_custom_fields_changed') {setError('تغيرت تعريفات الحقول. حمّل التعريفات الحالية من الهيدر؛ مدخلاتك محفوظة.');return;}
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
      const wasNew = editor === 'new';
      let data: StudentContext;
      if (wasNew) {
        const submission = await response.json() as { student: Student };
        const detail = await centerRequest(`students/${submission.student.id}`, 'GET');
        if (!detail.ok) { setError(await responseMessage(detail)); return; }
        data = await detail.json() as StudentContext;
      } else {
        data = await response.json() as StudentContext;
      }
      setCustomFields(data.custom_fields);
      open(data.students[0]);
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
      <form id={`${formPrefix}-0`} className='context-card form-stack' aria-label={editor === 'new' ? 'ملف طالب جديد' : `تعديل ملف ${editor.name}`} noValidate onSubmit={save}>
<FieldGroup>

        <FieldSet disabled={busy} className="form-stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <h2>البيانات الشخصية</h2>
        <div className='student-fields'>
        <FormField id='student-name' label='اسم الطالب' focusOnMount value={name} onChange={(value) => { setSaved(false); setName(value); setFieldErrors({}); setSimilar([]); }} error={fieldErrors.name} required autoComplete='off' />
        <FormField id='student-date_of_birth' label='تاريخ الميلاد' value={general.date_of_birth ?? ''} onChange={(value) => changeGeneral('date_of_birth', value)} error={fieldErrors.date_of_birth} direction='ltr' hint='اختياري بصيغة YYYY-MM-DD. العمر يُحسب تلقائيًا من التاريخ.' />
        <FieldSet data-invalid={Boolean(fieldErrors.gender)}><FieldLegend>النوع (اختياري)</FieldLegend><Field data-invalid={Boolean(fieldErrors.gender)}><RadioGroup disabled={busy} aria-invalid={Boolean(fieldErrors.gender)} name='student-gender' value={general.gender ?? ''} onValueChange={(value) => changeGeneral('gender', String(value))}>{[['', 'غير محدد'], ['male', 'ذكر'], ['female', 'أنثى']].map(([value, label]) => <FieldLabel className="flex items-center gap-2" key={value}><RadioGroupItem value={value} />{label}</FieldLabel>)}</RadioGroup></Field>{fieldErrors.gender ? <p className='field-error' role='alert'>{fieldErrors.gender}</p> : null}</FieldSet>
        <FormField id='student-address' label='العنوان' value={general.address ?? ''} onChange={(value) => changeGeneral('address', value)} error={fieldErrors.address} autoComplete='street-address' />
        </div>
        {context.student_code_settings.enabled ? <FormField id={`${formPrefix}-manual-code`} label={context.student_code_settings.label} value={manualCode} direction='ltr' autoComplete='off' error={fieldErrors.manual_code} hint='اختياري. احتفظ بالأصفار والأحرف؛ الرمز فريد داخل المركز ولا يطابق رقم طالب آخر.' onChange={value => {setSaved(false);setManualCode(value);setFieldErrors({});}} /> : editor !== 'new' && editor.manual_code ? <p>{context.student_code_settings.label} — معطل، والقيمة محفوظة: <bdi dir='ltr'>{editor.manual_code}</bdi></p> : null}
        {canReadIdentity ? <StudentIdentityFields key={editor === 'new' ? requestId : `${editor.id}-${editor.revision}`} prefix={formPrefix} identity={identity} onChange={value => {setSaved(false);setIdentity(value);setFieldErrors({});}} dateOfBirth={general.date_of_birth} onBirthChange={value => changeGeneral('date_of_birth',value)} studentId={editor === 'new' ? undefined : editor.id} branchIds={branchIds} errors={fieldErrors} onFieldErrors={setFieldErrors} busy={busy} canManage={canManageIdentity} onBusyChange={value => {saving.current=value;setBusy(value);}} /> : null}
        <h2>التواصل</h2><div className='student-fields'>
        <FormField id='student-email' label='البريد الإلكتروني' type='email' direction='ltr' value={general.email ?? ''} onChange={(value) => changeGeneral('email', value)} error={fieldErrors.email} autoComplete='email' />
        {editor !== 'new' && editor.legacy_phone !== null ? <FormField id='student-phone' label='رقم التواصل' value={phone} onChange={(value) => { setSaved(false); setPhone(value); setFieldErrors({}); setSimilar([]); }} error={fieldErrors.phone} type='tel' direction='ltr' autoComplete='off' hint='رقم سابق بصاحب غير محدد. أضف جهة وقناة لاستكمال صاحب الرقم؛ يبقى الرقم السابق محفوظًا.' /> : null}
        </div><StudentContactFields prefix={formPrefix} data={contactData} onChange={value => { setSaved(false); setContactData(value); setFieldErrors({}); setSimilar([]); }} errors={fieldErrors} disabled={busy} /><h2>خلفية الدراسة والعمل</h2><div className='student-fields'>
        {([['school', 'المدرسة / جهة الدراسة'], ['employer', 'جهة العمل'], ['specialization', 'التخصص']] as const).map(([key, label]) => <FormField key={key} id={`student-${key}`} label={label} value={general[key] ?? ''} onChange={(value) => changeGeneral(key, value)} error={fieldErrors[key]} />)}
        </div>
        <h2>اختيارات المركز والمصدر</h2><p className='muted'>طريقة جمع البيانات مستقلة عن مصدر المعرفة بالمركز. يُسجل الموظف وتاريخ الإنشاء تلقائيًا.</p>
        <StudentChoiceFields prefix={formPrefix} context={context} student={editor === 'new' ? undefined : editor} data={general} onChange={changeGeneral} errors={fieldErrors} disabled={busy} />
        <StudentCustomFields canReadIdentity={canReadIdentity} prefix={formPrefix} list={customFields} onListChange={setCustomFields} values={customValues} onValuesChange={values=>{setSaved(false);setCustomValues(values);}} studentId={editor === 'new' ? undefined : editor.id} onLoadedValues={loaded=>{setCustomValues(current=>({...loaded,...current}));setCustomBaseline(current=>({...loaded,...current}));}} errors={fieldErrors} disabled={busy} onBusyChange={value=>{saving.current=value;setBusy(value);}} />
        <FieldSet data-invalid={Boolean(fieldErrors.branch_ids)} aria-describedby={fieldErrors.branch_ids ? 'student-branches-error' : 'student-branches-hint'}><FieldLegend>الفروع المرتبطة بالطالب</FieldLegend>
          <p id='student-branches-hint' className='muted'>اختر فروع التسجيل المصرح بها. تبقى ارتباطات الملف السابقة محفوظة.</p>
          {manageable.map((branch) => {
            const associated = editor !== 'new' && editor.branch_ids.includes(branch.id);
            return <FieldLabel key={branch.id} className="flex items-center gap-2"><Checkbox  aria-invalid={Boolean(fieldErrors.branch_ids)} checked={branchIds.includes(branch.id)} disabled={busy || associated} onCheckedChange={(checked) => { setSaved(false); setBranchIds((ids) => checked ? [...ids, branch.id] : ids.filter((id) => id !== branch.id)); setFieldErrors({}); }} />{branch.name}{associated ? ' — مرتبط بالفعل' : ''}</FieldLabel>;
          })}
          {hasMoreBranches ? <Button busy={loadingBranches} onClick={loadMoreBranches}>تحميل المزيد من الفروع</Button> : null}
          {fieldErrors.branch_ids ? <p id='student-branches-error' className='field-error' role='alert'>{fieldErrors.branch_ids}</p> : null}
        </FieldSet>
        {similar.length ? <InlineNotice tone='warning'><strong>توجد ملفات ببيانات متشابهة ضمن نطاق صلاحيتك.</strong><p>راجع الملف المتاح ضمن فروعك لإعادة استخدامه. البيانات الأساسية خارج فروعك لا تمنح تعديل الملف؛ تواصل مع مسؤول المركز عند الحاجة. يمكنك حفظ ملف مستقل إذا كان طالبًا آخر؛ لا تُدمج الملفات تلقائيًا.</p><ul>{similar.map((student) => <li key={student.id}>{student.within_scope === false ? <span>{student.name} — رقم {student.student_number.toLocaleString('ar-EG')} · بيانات أساسية خارج فروعك</span> : <Link href={`/admin/students/${student.id}`}>{student.name} — رقم {student.student_number.toLocaleString('ar-EG')}</Link>}{student.phone ? <bdi> · {student.phone}</bdi> : null}</li>)}</ul></InlineNotice> : null}
        <CenterHeaderActions>{conflict ? <Button disabled={busy} onClick={reloadStudent}>تحميل أحدث بيانات الطالب</Button> : null}<Button form={`${formPrefix}-0`} type='submit' variant='primary' busy={busy} disabled={conflict}>{similar.length && editor === 'new' ? 'إنشاء ملف مستقل' : editor === 'new' ? 'حفظ ملف الطالب' : 'حفظ بيانات الطالب'}</Button><Link inert={busy || undefined} aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault(); }} tabIndex={busy ? -1 : undefined} className={buttonVariants({ variant: 'outline' })} href={editor === 'new' ? '/admin/students?focus=create' : `/admin/students/${editor.id}?focus=edit`}>إلغاء</Link></CenterHeaderActions>
        </FieldSet>
      </FieldGroup>
</form>
  </>;
}

function profileData(student?: Student): StudentGeneralData {
  return { date_of_birth: student?.date_of_birth ?? null, gender: student?.gender ?? null, address: student?.address ?? null,
    email: student?.email ?? null, school: student?.school ?? null, employer: student?.employer ?? null, specialization: student?.specialization ?? null, city_id: student?.city_id ?? null, qualification_id: student?.qualification_id ?? null, profession_id: student?.profession_id ?? null, collection_method_id: student?.collection_method_id ?? null, discovery_source_id: student?.discovery_source_id ?? null };
}
