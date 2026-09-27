'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CenterHeaderActions } from "@/components/CenterShell";
import { Button } from '@/components/Button';
import { ConfirmationDialog } from '@/components/ConfirmationDialog';
import { InlineNotice } from '@/components/InlineNotice';
import { centerRequest, responseMessage } from '@/lib/client-api';
import type { Student, StudentContext } from '@/lib/server-context';

export function StudentSharingControls({ student, inHeader = false, compact = false }: { student: Student; inHeader?: boolean; compact?: boolean }) {
  const router = useRouter();
  const [current, setCurrent] = useState(student);
  const [loadedStudent, setLoadedStudent] = useState(student);
  if (loadedStudent !== student) { setLoadedStudent(student); setCurrent(student); }
  const [confirmation, setConfirmation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const saving = useRef(false);
  const actionButton = useRef<HTMLButtonElement>(null);

  async function changeSharing() {
    if (saving.current) return;
    saving.current = true; setBusy(true); setConfirmation(false); setError(''); setNotice('');
    try {
      const response = await centerRequest(`students/${current.id}/sharing`, 'PATCH', { sharing_enabled: !current.sharing_enabled, revision: current.revision });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setError('تغيّر ملف الطالب. حمّل أحدث بياناته قبل تغيير المشاركة.'); }
        else { setError(await responseMessage(response)); router.refresh(); }
        return;
      }
      setCurrent((await response.json()).student as Student); setConflict(false);
      setNotice('حُفظ اختيار مشاركة الطالب.'); router.refresh();
    } catch { setError('تعذر التأكد من حفظ المشاركة. حمّل أحدث بيانات الطالب قبل المحاولة.'); setConflict(true); }
    finally { saving.current = false; setBusy(false); }
  }

  async function reloadStudent() {
    if (saving.current) return;
    saving.current = true; setBusy(true);
    try {
      const response = await centerRequest(`students/${current.id}`, 'GET');
      if (!response.ok) { setError(await responseMessage(response)); router.refresh(); return; }
      const data = await response.json() as StudentContext;
      setCurrent(data.students[0]); setConflict(false); setError(''); setNotice('حُمّلت أحدث بيانات الطالب. راجع المشاركة قبل تغييرها.'); router.refresh();
      requestAnimationFrame(() => actionButton.current?.focus());
    } catch { setError('تعذر تحميل أحدث بيانات الطالب. تحقق من الاتصال وأعد المحاولة.'); }
    finally { saving.current = false; setBusy(false); }
  }

  return <div className={compact ? 'student-row-actions' : 'form-stack'}>
    {!compact || !current.can_manage ? <span>المشاركة بين الفروع: {current.sharing_enabled ? 'مسموحة' : 'مغلقة'}</span> : null}
    {inHeader ? <CenterHeaderActions>    {current.can_manage ? <Button ref={actionButton} busy={busy} disabled={conflict} onClick={() => setConfirmation(true)} aria-label='تغيير مشاركة الطالب'>{compact ? `المشاركة: ${current.sharing_enabled ? 'مسموحة' : 'مغلقة'}` : 'تغيير مشاركة الطالب'}</Button> : null}
    {conflict ? <Button disabled={busy} onClick={reloadStudent}>تحميل أحدث بيانات المشاركة</Button> : null}
</CenterHeaderActions> : <>    {current.can_manage ? <Button ref={actionButton} busy={busy} disabled={conflict} onClick={() => setConfirmation(true)} aria-label='تغيير مشاركة الطالب'>{compact ? `المشاركة: ${current.sharing_enabled ? 'مسموحة' : 'مغلقة'}` : 'تغيير مشاركة الطالب'}</Button> : null}
    {conflict ? <Button disabled={busy} onClick={reloadStudent}>تحميل أحدث بيانات المشاركة</Button> : null}
</>}
    {error ? <InlineNotice tone='error'>{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {confirmation ? <ConfirmationDialog title={`تغيير مشاركة ${current.name}`} description={current.sharing_enabled ? 'لن يظهر هذا الطالب خارج فروع الموظف. يبقى ملفه متاحًا داخل الفروع المصرح بها.' : 'يمكن لصاحب منحة البحث العثور على اسم الطالب ورقمه والتواصل عند فتح البحث العام للمركز. لا تمنح المشاركة فتح الملف أو الدراسة أو المال أو الهوية خارج فروعه.'} confirmLabel={current.sharing_enabled ? 'غلق مشاركة الطالب' : 'السماح بمشاركة الطالب'} onCancel={() => setConfirmation(false)} onConfirm={changeSharing} /> : null}
  </div>;
}
