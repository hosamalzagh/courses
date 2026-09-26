"use client";

import { Button } from "@/components/Button";
import { useState, type FormEvent } from "react";
import { CenterShell } from "@/components/CenterShell";
import type { CenterContext } from "@/lib/server-context";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, responseFieldErrors, responseMessage } from "@/lib/client-api";

type Settings = { contact_email: string | null; phone: string | null; address: string | null };

export function SettingsWorkspace({ context, initialSettings }: { context: CenterContext; initialSettings: Settings }) {
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
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر حفظ الإعدادات."); }
    finally { setBusy(false); }
  }

  return <CenterShell context={context} title="إعدادات المركز" description="بيانات التواصل والعنوان المستخدمة في التشغيل اليومي." actions={<Button variant="primary" form="center-settings" disabled={busy} type="submit" busy={busy} busyLabel="جارٍ الحفظ…">حفظ الإعدادات</Button>}>
    <main className="members-main">
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      <form id="center-settings" className="context-card form-stack" noValidate onSubmit={save}>
        <FormField id="contact-email" label="بريد التواصل" type="email" value={email} onChange={(value) => { setEmail(value); setFieldErrors({}); }} error={fieldErrors.contact_email} direction="ltr" />
        <FormField id="phone" label="الهاتف" type="tel" value={phone} onChange={(value) => { setPhone(value); setFieldErrors({}); }} error={fieldErrors.phone} direction="ltr" />
        <FormField id="address" label="العنوان" value={address} onChange={(value) => { setAddress(value); setFieldErrors({}); }} error={fieldErrors.address} />

      </form>
    </main>
  </CenterShell>;
}
