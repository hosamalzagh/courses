'use client';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useWorkspaceRouter as useRouter } from "@/components/WorkspaceNavigation";
import { CenterHeaderActions } from '@/components/CenterShell';
import { UnsavedChangesGuard } from '@/components/UnsavedChangesGuard';
import { Button } from '@/components/Button';
import { FormField } from '@/components/FormField';
import { InlineNotice } from '@/components/InlineNotice';
import { SettingsRow } from '@/components/SettingsRow';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldGroup, FieldSet, FieldLabel } from '@/components/ui/field';
import { centerRequest, responseFieldErrors, responseMessage } from '@/lib/client-api';
import type { CenterSettings } from '@/lib/server-context';

type CodeSettings = { enabled: boolean; label: string; revision: number };
function codeSettings(settings: CenterSettings): CodeSettings { return { enabled: Boolean(settings.student_code_enabled), label: settings.student_code_label ?? 'الباركود الإضافي', revision: settings.student_code_revision ?? 1 }; }
export function StudentCodeControls({ settings }: { settings: CenterSettings }) {
  const prefix = useId(); const router = useRouter(); const saving = useRef(false);
  const [saved, setSaved] = useState(() => codeSettings(settings)); const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false); const [conflict, setConflict] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [errors, setErrors] = useState<Record<string,string>>({});
  const dirty = draft.enabled !== saved.enabled || draft.label !== saved.label;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (saving.current) return;
    if (!draft.label.trim()) { setErrors({label:'أدخل اسم الباركود الإضافي.'}); return; }
    saving.current = true; setBusy(true); setError(''); setErrors({}); setNotice('');
    try {
      const response = await centerRequest('student-code-settings','PATCH',draft);
      if (!response.ok) { setErrors(await responseFieldErrors(response)); setConflict(response.status === 409); throw new Error(await responseMessage(response)); }
      const value = codeSettings((await response.json()).settings); setSaved(value); setDraft(value); setConflict(false);
      setNotice('حُفظ إعداد الباركود الإضافي.'); router.refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'تعذر حفظ إعداد الباركود. مدخلاتك محفوظة.'); }
    finally { saving.current = false; setBusy(false); }
  }
  async function reload() {
    if (saving.current) return; saving.current=true; setBusy(true); setError('');
    try {
      const response = await centerRequest('settings','GET'); if (!response.ok) throw new Error(await responseMessage(response));
      const value = codeSettings((await response.json()).settings); setSaved(value); setDraft(value); setConflict(false); setErrors({});
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'تعذر تحميل الإعداد الحالي.'); }
    finally { saving.current=false; setBusy(false); }
  }
  return <form id={`${prefix}-code-settings`} className='settings-list' aria-label='إعداد الباركود الإضافي' noValidate onSubmit={submit}>
    <SettingsRow title='الباركود الإضافي' description='رمز يدوي باسم يختاره المركز. تعطيله يحفظ القيم السابقة ويوقف استخدامها في البحث.'>
    <FieldGroup><UnsavedChangesGuard guardHistory dirty={dirty} />
      {error ? <InlineNotice tone='error'>{error}</InlineNotice> : null}{notice ? <InlineNotice>{notice}</InlineNotice> : null}
      <FieldSet disabled={busy}>
        <Field orientation='horizontal'><Checkbox id={`${prefix}-code-enabled`} checked={draft.enabled} onCheckedChange={enabled => {setDraft({...draft,enabled:Boolean(enabled)});setError('');setNotice('');}} /><FieldLabel htmlFor={`${prefix}-code-enabled`}>تفعيل الباركود الإضافي</FieldLabel></Field>
        <FormField id={`${prefix}-code-label`} label='اسم الباركود الإضافي' required value={draft.label} error={errors.label} onChange={label => {setDraft({...draft,label});setErrors({});setError('');setNotice('');}} />
        <CenterHeaderActions>{dirty ? <Button type='submit' form={`${prefix}-code-settings`} variant='primary' busy={busy} disabled={conflict}>حفظ إعداد الباركود الإضافي</Button> : null}{conflict ? <Button disabled={busy} onClick={reload}>تحميل إعداد الباركود الحالي</Button> : null}</CenterHeaderActions>
      </FieldSet>
    </FieldGroup>
    </SettingsRow>
  </form>;
}
