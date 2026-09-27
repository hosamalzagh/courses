"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { Button } from "@/components/Button";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, responseFieldErrors, responseMessage } from "@/lib/client-api";

export function StudentNumberingControls({ start, revision }: { start: number; revision: number }) {
  const router = useRouter();
  const [value, setValue] = useState(String(start));
  const [savedValue, setSavedValue] = useState(String(start));
  const [currentRevision, setCurrentRevision] = useState(revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);


  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setFieldError(""); setNotice(""); setConflict(false);
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
    finally { setBusy(false); }
  }

  async function reload() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v1/center/settings", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(await responseMessage(response));
      const data = await response.json();
      setValue(String(data.settings.student_number_start));
      setSavedValue(String(data.settings.student_number_start)); setCurrentRevision(data.settings.student_number_revision); setConflict(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر تحميل الإعداد الحالي."); }
    finally { setBusy(false); }
  }

  return <form className="context-card form-stack" noValidate onSubmit={save} aria-label="ترقيم الطلاب">
    <UnsavedChangesGuard dirty={value !== savedValue} />
    <h2>ترقيم الطلاب</h2>
    <p>تسلسل واحد لجميع فروع المركز. تغيير البداية يحفظ أرقام الطلاب الحالية، ولا يعيد استعمال رقم صدر سابقًا. إذا كانت البداية أقل من التسلسل الحالي يستمر الترقيم منه.</p>
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    <FormField id="student-number-start" label="بداية ترقيم الطلاب" value={value} onChange={(next) => { setValue(next); setFieldError(""); }} type="number" direction="ltr" required error={fieldError} />
    <div className="form-actions">
      <Button variant="primary" type="submit" disabled={busy || conflict} busy={busy} busyLabel="جارٍ الحفظ…">حفظ بداية الترقيم</Button>
      {conflict ? <Button type="button" disabled={busy} onClick={reload}>تحميل إعداد الترقيم الحالي</Button> : null}
    </div>
  </form>;
}
