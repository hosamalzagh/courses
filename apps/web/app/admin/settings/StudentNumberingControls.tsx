"use client";

import { useId } from "react";

import { FieldGroup, FieldSet } from "@/components/ui/field";


import { CenterHeaderActions } from "@/components/CenterShell";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { Button } from "@/components/Button";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { SettingsRow } from "@/components/SettingsRow";
import { centerRequest, responseFieldErrors, responseMessage } from "@/lib/client-api";

export function StudentNumberingControls({ start, revision }: { start: number; revision: number }) {
  const formPrefix = useId();
  const router = useRouter();
  const [value, setValue] = useState(String(start));
  const [savedValue, setSavedValue] = useState(String(start));
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const saving = useRef(false);


  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setError(""); setFieldError(""); setNotice(""); setConflict(false);
    try {
      const response = await centerRequest("student-numbering", "PATCH", { start: value, revision: currentRevision });
      if (!response.ok) {
        setFieldError((await responseFieldErrors(response)).start ?? "");
        setConflict(response.status === 409);
        throw new Error(await responseMessage(response));
      }
      const data = await response.json();
      setValue(String(data.settings.student_number_start));
      setSavedValue(String(data.settings.student_number_start));
      setCurrentRevision(data.settings.student_number_revision);
      setNotice("حُفظت بداية ترقيم الطلاب.");
      router.refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر حفظ بداية الترقيم."); }
    finally { saving.current = false; setBusy(false); }
  }

  async function reload() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setError("");
    try {
      const response = await centerRequest("settings", "GET");
      if (!response.ok) throw new Error(await responseMessage(response));
      const data = await response.json();
      setValue(String(data.settings.student_number_start));
      setSavedValue(String(data.settings.student_number_start)); setCurrentRevision(data.settings.student_number_revision); setConflict(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر تحميل الإعداد الحالي."); }
    finally { saving.current = false; setBusy(false); }
  }

  return <form id={`${formPrefix}-0`} className="settings-list" noValidate onSubmit={save} aria-label="ترقيم الطلاب">
    <SettingsRow title="ترقيم الطلاب" description="تسلسل واحد لكل فروع المركز. تغيير البداية يحفظ الأرقام الحالية ولا يعيد استعمال رقم صدر سابقًا.">
      <FieldGroup>
    <UnsavedChangesGuard dirty={value !== savedValue} />
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    <FieldSet disabled={busy} className="form-stack" style={{ border: 0, margin: 0, padding: 0 }}>
    <FormField id="student-number-start" label="بداية ترقيم الطلاب" value={value} onChange={(next) => { setValue(next); setFieldError(""); }} type="number" direction="ltr" required error={fieldError} />
    <CenterHeaderActions>
      <Button form={`${formPrefix}-0`} variant="primary" type="submit" disabled={busy || conflict} busy={busy} busyLabel="جارٍ الحفظ…">حفظ بداية الترقيم</Button>
      {conflict ? <Button type="button" disabled={busy} onClick={reload}>تحميل إعداد الترقيم الحالي</Button> : null}
    </CenterHeaderActions>
    </FieldSet>
      </FieldGroup>
    </SettingsRow>
</form>;
}
