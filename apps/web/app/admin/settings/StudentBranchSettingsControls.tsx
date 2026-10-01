'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { useWorkspaceRouter as useRouter } from "@/components/WorkspaceNavigation";
import { CenterHeaderActions } from '@/components/CenterShell';
import { UnsavedChangesGuard } from '@/components/UnsavedChangesGuard';
import { Button } from '@/components/Button';
import { InlineNotice } from '@/components/InlineNotice';
import { SettingsRow } from '@/components/SettingsRow';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { centerRequest, responseMessage } from '@/lib/client-api';
import type { CenterSettings } from '@/lib/server-context';

type BranchSettings = { enabled: boolean; revision: number };

function branchSettings(settings: CenterSettings): BranchSettings {
  return { enabled: Boolean(settings.student_all_branches_enabled), revision: settings.student_all_branches_revision ?? 1 };
}

export function StudentBranchSettingsControls({ settings }: { settings: CenterSettings }) {
  const prefix = useId();
  const router = useRouter();
  const saving = useRef(false);
  const [saved, setSaved] = useState(() => branchSettings(settings));
  const [enabled, setEnabled] = useState(saved.enabled);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dirty = enabled !== saved.enabled;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const response = await centerRequest('student-branch-settings', 'PATCH', { enabled, revision: saved.revision });
      if (!response.ok) {
        setConflict(response.status === 409);
        throw new Error(await responseMessage(response));
      }
      const current = branchSettings((await response.json()).settings);
      setSaved(current); setEnabled(current.enabled); setConflict(false);
      setNotice('حُفظ إعداد ربط ملفات الطلاب الجديدة بالفروع.');
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'تعذر حفظ إعداد الفروع.');
    } finally { saving.current = false; setBusy(false); }
  }

  async function reload() {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const response = await centerRequest('settings', 'GET');
      if (!response.ok) throw new Error(await responseMessage(response));
      const current = branchSettings((await response.json()).settings);
      setSaved(current); setEnabled(current.enabled); setConflict(false);
      setNotice('حُمّل أحدث إعداد للفروع.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'تعذر تحميل إعداد الفروع.');
    } finally { saving.current = false; setBusy(false); }
  }

  return <form id={`${prefix}-student-branches`} className='settings-list' aria-label='إعداد فروع ملفات الطلاب' noValidate onSubmit={save}>
    <SettingsRow title='فروع ملفات الطلاب الجديدة' description='حدد هل يرتبط الملف الذي ينشئه مالك المركز أو مسؤوله بكل الفروع تلقائيًا. يظل موظف التسجيل مقيدًا بفروعه المصرح بها.'>
      <UnsavedChangesGuard guardHistory dirty={dirty} />
      {error ? <InlineNotice tone='error'>{error}</InlineNotice> : null}
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      <Field orientation='horizontal' data-disabled={busy}>
        <Checkbox id={`${prefix}-branch-enabled`} checked={enabled} disabled={busy} aria-describedby={`${prefix}-description`} onCheckedChange={checked => { setEnabled(Boolean(checked)); setError(''); setNotice(''); }} />
        <FieldContent>
          <FieldLabel htmlFor={`${prefix}-branch-enabled`}>ربط كل ملف طالب جديد بجميع فروع المركز</FieldLabel>
          <FieldDescription id={`${prefix}-description`}>يسري على الملفات الجديدة التي ينشئها مالك المركز أو مسؤوله فقط؛ ارتباطات الطلاب الحاليين لا تتغير.</FieldDescription>
        </FieldContent>
      </Field>
      <CenterHeaderActions>
        {dirty ? <Button type='submit' form={`${prefix}-student-branches`} variant='primary' busy={busy} disabled={conflict}>حفظ إعداد الفروع</Button> : null}
        {conflict ? <Button disabled={busy} onClick={reload}>تحميل إعداد الفروع الحالي</Button> : null}
      </CenterHeaderActions>
    </SettingsRow>
  </form>;
}
