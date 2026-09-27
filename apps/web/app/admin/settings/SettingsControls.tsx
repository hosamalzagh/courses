"use client";

import { StudentNumberingControls } from "./StudentNumberingControls";
import { Button } from "@/components/Button";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CenterPageActions } from "@/components/CenterShell";
import type { CenterContext } from "@/lib/server-context";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, responseFieldErrors, responseMessage } from "@/lib/client-api";

type Settings = { contact_email: string | null; phone: string | null; address: string | null; student_number_start?: number; student_number_revision?: number };

export function SettingsControls({ context, initialSettings }: { context: CenterContext; initialSettings: Settings }) {
  const router = useRouter();
  const [email, setEmail] = useState(initialSettings.contact_email ?? "");
  const [phone, setPhone] = useState(initialSettings.phone ?? "");
  const [address, setAddress] = useState(initialSettings.address ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setFieldErrors({}); setNotice("");
    try {
      const response = await centerRequest("settings", "PATCH", {
        contact_email: email || null, phone: phone || null, address: address || null,
      });
      if (!response.ok) {
        setFieldErrors(await responseFieldErrors(response));
        throw new Error(await responseMessage(response));
      }
      setNotice("حُفظت إعدادات المركز.");
      router.refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر حفظ الإعدادات."); }
    finally { setBusy(false); }
  }

  return <>
    <CenterPageActions context={context} actions={<Button variant="primary" form="center-settings" disabled={busy} type="submit" busy={busy} busyLabel="جارٍ الحفظ…">حفظ الإعدادات</Button>} />
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      <form id="center-settings" className="context-card form-stack" noValidate onSubmit={save}>
        <FormField id="contact-email" label="بريد التواصل" type="email" value={email} onChange={(value) => { setEmail(value); setFieldErrors({}); }} error={fieldErrors.contact_email} direction="ltr" />
        <FormField id="phone" label="الهاتف" type="tel" value={phone} onChange={(value) => { setPhone(value); setFieldErrors({}); }} error={fieldErrors.phone} direction="ltr" />
        <FormField id="address" label="العنوان" value={address} onChange={(value) => { setAddress(value); setFieldErrors({}); }} error={fieldErrors.address} />

      </form>
      <StudentNumberingControls start={initialSettings.student_number_start ?? 1} revision={initialSettings.student_number_revision ?? 1} />
  </>;
}
