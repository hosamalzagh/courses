'use client';

import { useRef, useState } from 'react';
import { CenterHeaderActions } from './CenterShell';
import { Button } from './Button';
import { FormField } from './FormField';
import { FieldSet, FieldLegend } from './ui/field';
import { InlineNotice } from './InlineNotice';
import { centerRequest, responseFieldErrors, responseMessage } from '@/lib/client-api';
import type { StudentIdentityData } from '@/lib/server-context';

type BirthPreview = { date_of_birth: string; saved_date_of_birth: string | null; conflict: boolean };
export function StudentIdentityFields({ prefix, identity, onChange, dateOfBirth, onBirthChange, studentId, branchIds, errors, busy, canManage, onBusyChange, onFieldErrors }: {
  prefix: string; identity: StudentIdentityData; onChange: (value: StudentIdentityData) => void;
  dateOfBirth: string | null; onBirthChange: (value: string) => void; studentId?: string; branchIds: number[];
  errors: Record<string,string>; busy: boolean; canManage: boolean; onBusyChange: (value: boolean) => void; onFieldErrors: (value: Record<string,string>) => void;
}) {
  const reviewing = useRef(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<BirthPreview | null>(null);
  const [error, setError] = useState('');
  async function review() {
    if (reviewing.current || busy) return;
    reviewing.current=true; setLoading(true); onBusyChange(true); setError(''); onFieldErrors({}); setPreview(null);
    try {
      const response=await centerRequest('students/identity-preview','POST',{national_id:identity.national_id ?? '',student_id:studentId,branch_ids:branchIds,date_of_birth:dateOfBirth});
      if (!response.ok) {onFieldErrors(await responseFieldErrors(response)); throw new Error(await responseMessage(response));}
      setPreview(await response.json() as BirthPreview);
    } catch(failure) {setError(failure instanceof Error ? failure.message : 'تعذر مراجعة الميلاد. المدخلات محفوظة.');}
    finally {reviewing.current=false; setLoading(false); onBusyChange(false);}
  }
  return <FieldSet disabled={busy || !canManage}>
    <FieldLegend>بيانات الهوية</FieldLegend>
    <p className='muted'>اختيارية ومقيدة بصلاحية الهوية داخل فروع الملف. استخراج الميلاد مراجعة لصيغة الإدخال، وليس تحققًا حكوميًا من هوية الطالب. الجواز لا يستخرج ميلادًا ولا يشترط تاريخ ميلاد.</p>
    {error ? <InlineNotice tone='error'>{error}</InlineNotice> : null}
    <div className='student-fields'>
      <FormField id={`${prefix}-national-id`} label='الرقم القومي المصري' direction='ltr' autoComplete='off' value={identity.national_id ?? ''} error={errors.national_id} onChange={value=>{onChange({...identity,national_id:value || null});setPreview(null);onFieldErrors({});setError('');}} />
      <FormField id={`${prefix}-passport`} label='رقم جواز السفر' direction='ltr' autoComplete='off' value={identity.passport_number ?? ''} error={errors.passport_number} onChange={value=>onChange({...identity,passport_number:value || null})} />
    </div>
    {preview ? <div aria-live='polite'><p>الميلاد المستخرج: <bdi dir='ltr'>{preview.date_of_birth}</bdi></p>{preview.saved_date_of_birth && preview.saved_date_of_birth !== preview.date_of_birth ? <p>تعارض مع الميلاد المحفوظ: <bdi dir='ltr'>{preview.saved_date_of_birth}</bdi>. لم يتغير التاريخ المحفوظ.</p> : null}{dateOfBirth && dateOfBirth !== preview.date_of_birth ? <InlineNotice tone='error'>تعارض مع تاريخ الميلاد المدخل. صحح الرقم أو اختر استخدام الميلاد المستخرج.</InlineNotice> : null}</div> : null}
    {canManage ? <CenterHeaderActions><Button disabled={busy} busy={loading} onClick={review}>مراجعة الميلاد من الرقم القومي</Button>{preview && preview.date_of_birth !== dateOfBirth ? <Button disabled={busy} onClick={()=>onBirthChange(preview.date_of_birth)}>استخدام الميلاد المستخرج</Button> : null}</CenterHeaderActions> : null}
  </FieldSet>;
}
