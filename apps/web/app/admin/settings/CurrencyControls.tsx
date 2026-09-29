"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { InlineNotice } from "@/components/InlineNotice";
import { SettingsRow } from "@/components/SettingsRow";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { centerRequest, responseFieldErrors, responseMessage } from "@/lib/client-api";
import type { CenterSettings } from "@/lib/server-context";

const currencies = ["EGP", "SAR", "AED", "USD", "EUR", "GBP"];

export function CurrencyControls({ settings }: { settings: CenterSettings }) {
  const formId = useId();
  const router = useRouter();
  const saving = useRef(false);
  const serverVersion = useRef(`${settings.financial_currency_revision}:${settings.financial_currency_locked_at}`);
  const [saved, setSaved] = useState(settings.financial_currency ?? "");
  const [value, setValue] = useState(saved);
  const [revision, setRevision] = useState(settings.financial_currency_revision ?? 1);
  const [locked, setLocked] = useState(Boolean(settings.financial_currency_locked_at));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const version = `${settings.financial_currency_revision}:${settings.financial_currency_locked_at}`;
    if (version === serverVersion.current) return;
    serverVersion.current = version;
    setSaved(settings.financial_currency ?? "");
    setValue(settings.financial_currency ?? "");
    setRevision(settings.financial_currency_revision ?? 1);
    setLocked(Boolean(settings.financial_currency_locked_at));
  }, [settings.financial_currency, settings.financial_currency_revision, settings.financial_currency_locked_at]);

  async function reload() {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try {
      const response = await centerRequest("settings", "GET");
      if (!response.ok) throw new Error(await responseMessage(response));
      const data = (await response.json()).settings as CenterSettings;
      setSaved(data.financial_currency ?? ""); setValue(data.financial_currency ?? "");
      setRevision(data.financial_currency_revision ?? 1);
      setLocked(Boolean(data.financial_currency_locked_at));
      setConflict(false); setFieldError(""); setNotice("حُمّلت أحدث عملة للمركز.");
    } catch { setError("تعذر تحميل العملة الحالية. حاول مرة أخرى."); }
    finally { saving.current = false; setBusy(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current || locked || conflict || value === saved) return;
    if (!value) { setFieldError("اختر عملة المركز."); document.getElementById(`${formId}-currency`)?.focus(); return; }
    saving.current = true; setBusy(true); setError(""); setNotice(""); setFieldError("");
    try {
      const response = await centerRequest("financial-currency", "PATCH", { currency: value, revision });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setError("تغيرت عملة المركز أو سُجلت حركة مالية. حمّل أحدث إعداد."); }
        else { setFieldError((await responseFieldErrors(response)).currency ?? ""); setError(await responseMessage(response)); }
        return;
      }
      const data = await response.json() as { currency: string; revision: number };
      setSaved(data.currency); setValue(data.currency); setRevision(data.revision);
      setNotice("حُفظت عملة المركز. ستثبت بعد أول حركة مالية.");
      router.refresh();
    } catch { setConflict(true); setError("تعذر التأكد من حفظ العملة. حمّل أحدث إعداد قبل المحاولة مجددًا."); }
    finally { saving.current = false; setBusy(false); }
  }

  return <form id={formId} className="settings-list" noValidate onSubmit={save}>
    <UnsavedChangesGuard dirty={value !== saved} guardHistory />
    <SettingsRow title="عملة المركز" description="عملة واحدة لكل فروع المركز. بعد أول حركة مالية تصبح ثابتة ولا يمكن تغييرها.">
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      {locked ? <p>العملة المعتمدة: <strong><bdi dir="ltr">{saved}</bdi></strong></p> : <Field data-invalid={Boolean(fieldError)}>
        <FieldLabel htmlFor={`${formId}-currency`}>عملة المركز</FieldLabel>
        <NativeSelect id={`${formId}-currency`} value={value} disabled={busy || conflict} aria-invalid={Boolean(fieldError)} aria-describedby={fieldError ? `${formId}-currency-error` : undefined} onChange={event => { setValue(event.target.value); setFieldError(""); setError(""); }}>
          <NativeSelectOption value="">اختر العملة</NativeSelectOption>
          {currencies.map(currency => <NativeSelectOption key={currency} value={currency}>{currency}</NativeSelectOption>)}
        </NativeSelect>
        {fieldError ? <FieldError id={`${formId}-currency-error`}>{fieldError}</FieldError> : null}
      </Field>}
      <CenterHeaderActions>
        {!locked && value !== saved ? <Button form={formId} type="submit" variant="primary" busy={busy} disabled={busy || conflict}>حفظ عملة المركز</Button> : null}
        {conflict ? <Button disabled={busy} onClick={reload}>تحميل أحدث إعداد للعملة</Button> : null}
      </CenterHeaderActions>
    </SettingsRow>
  </form>;
}
