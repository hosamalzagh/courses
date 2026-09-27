'use client';

import { useId } from "react";

import { FieldGroup, FieldSet } from "@/components/ui/field";


import { CenterHeaderActions } from "@/components/CenterShell";

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/Button';
import { FormField } from '@/components/FormField';
import { InlineNotice } from '@/components/InlineNotice';
import { ConfirmationDialog } from '@/components/ConfirmationDialog';
import { UnsavedChangesGuard } from '@/components/UnsavedChangesGuard';
import { centerRequest, newSubmissionId, responseFieldErrors, responseMessage } from '@/lib/client-api';
import type { Student, StudentContext } from '@/lib/server-context';

export function StudentStatusControls({ student }: { student: Student }) {
  const formPrefix = useId();
  const router = useRouter();
  const [decision, setDecision] = useState<{ student: Student; requestId: string } | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submittedReason, setSubmittedReason] = useState<string | null>(null);
  const saving = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = (decision?.student ?? student).status === 'active' ? 'إيقاف ملف الطالب' : 'فك إيقاف ملف الطالب';

  function close() {
    setDecision(null); setReason(''); setSubmittedReason(null); setError(''); setConflict(false);
    requestAnimationFrame(() => trigger.current?.focus());
  }
  function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reason.trim()) { setReasonError('أدخل سبب تغيير حالة الطالب.'); return; }
    setReasonError(''); setConfirming(true);
  }
  async function save() {
    if (!decision || saving.current) return;
    saving.current = true; setBusy(true); setConfirming(false); setError('');
    const sentReason = submittedReason ?? reason.trim();
    setSubmittedReason(sentReason);
    try {
      const response = await centerRequest(`students/${decision.student.id}/status`, 'POST', {
        status: decision.student.status === 'active' ? 'suspended' : 'active', reason: sentReason,
        status_revision: decision.student.status_revision, request_id: decision.requestId,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setError('تغيّرت حالة الملف. حمّل أحدث حالة وراجع القرار قبل إعادة المحاولة.'); }
        else { setReasonError((await responseFieldErrors(response)).reason ?? ''); setError(await responseMessage(response)); if (response.status === 422) setSubmittedReason(null); }
        return;
      }
      const message = decision.student.status === 'active' ? 'أُوقف ملف الطالب وحُفظ السبب.' : 'فُك إيقاف ملف الطالب وحُفظ السبب.';
      close(); setNotice(message); router.refresh();
    } catch { setError('تعذر تأكيد تغيير الحالة. أعد المحاولة بنفس القرار، أو حمّل أحدث حالة للتحقق قبل تغيير السبب.'); }
    finally { saving.current = false; setBusy(false); }
  }
  async function reload() {
    setBusy(true);
    try {
      const response = await centerRequest(`students/${student.id}`, 'GET');
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const latest = (await response.json() as StudentContext).students[0];
      if (!latest.can_change_status) { close(); router.refresh(); return; }
      setDecision({ student: latest, requestId: newSubmissionId() }); setConflict(false); setSubmittedReason(null); setError(''); setReason(''); router.refresh();
    } catch { setError('تعذر تحميل الحالة. تحقق من الاتصال وأعد المحاولة.'); }
    finally { setBusy(false); }
  }
  return <>
    {student.can_change_status && !decision ? <CenterHeaderActions><Button ref={trigger} variant={student.status === 'active' ? 'danger' : 'secondary'} onClick={() => { setDecision({ student, requestId: newSubmissionId() }); setNotice(''); }}>{label}</Button></CenterHeaderActions> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {error ? <InlineNotice tone='error'>{error}</InlineNotice> : null}
    <UnsavedChangesGuard dirty={decision !== null && reason !== ''} />
    {decision ? <form id={`${formPrefix}-0`} className='form-stack' aria-label={label} noValidate onSubmit={confirm}>
<FieldGroup>
      <h3>{label} — {student.name}</h3>
      <p>يُحفظ القرار وسببه في تاريخ الملف. تبقى التسجيلات والدراسة والحركات المالية محفوظة.</p>
      <FieldSet disabled={busy} className="form-stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <FormField id='student-status-reason' label='سبب تغيير الحالة' value={reason} onChange={(value) => { if (submittedReason === null) { setReason(value); setReasonError(''); } }} required focusOnMount error={reasonError} hint={submittedReason !== null ? 'القرار أُرسل؛ أعد المحاولة بنفس السبب أو حمّل أحدث حالة قبل قرار جديد.' : 'سبب إلزامي يظهر للموظفين المخولين بقراءة الملف.'} />
        <CenterHeaderActions>{conflict || submittedReason !== null ? <Button disabled={busy} onClick={reload}>تحميل أحدث حالة الطالب</Button> : null}<Button form={`${formPrefix}-0`} variant={decision.student.status === 'active' ? 'danger' : 'primary'} type='submit' busy={busy} disabled={conflict}>{label}</Button><Button disabled={busy} onClick={close}>إلغاء</Button></CenterHeaderActions>
      </FieldSet>
    </FieldGroup>
</form> : null}
    {confirming ? <ConfirmationDialog title={label} description={decision?.student.status === 'active' ? `إيقاف ملف ${student.name} في جميع فروع المركز بالسبب المسجل. تبقى سجلاته محفوظة.` : `فك إيقاف ملف ${student.name} بالسبب المسجل، مع حفظ فترة الإيقاف السابقة.`} confirmLabel={label} onCancel={() => setConfirming(false)} onConfirm={save} /> : null}
  </>;
}
