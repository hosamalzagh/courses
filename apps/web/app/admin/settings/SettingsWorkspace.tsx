"use client";

import { useState, type FormEvent } from "react";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, responseMessage } from "@/lib/client-api";

type Settings = { contact_email: string | null; phone: string | null; address: string | null };

export function SettingsWorkspace({ centerName, initialSettings }: { centerName: string; initialSettings: Settings }) {
  const [email, setEmail] = useState(initialSettings.contact_email ?? "");
  const [phone, setPhone] = useState(initialSettings.phone ?? "");
  const [address, setAddress] = useState(initialSettings.address ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest("settings", "PATCH", {
        contact_email: email || null, phone: phone || null, address: address || null,
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      setNotice("حُفظت إعدادات المركز.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر حفظ الإعدادات."); }
    finally { setBusy(false); }
  }

  return <div className="workspace">
    <header className="workspace-header"><div className="workspace-header-inner"><a className="brand" href="/admin"><span className="brand-mark">C</span>Courses</a><span className="muted">{centerName} · عضويتك نشطة</span><a className="text-link" href="/admin">العودة إلى الفروع</a></div></header>
    <main className="members-main"><div><span className="eyebrow">{centerName}</span><h1>إعدادات المركز</h1><p className="muted">بيانات التواصل والعنوان المستخدمة في التشغيل اليومي.</p></div>
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      <form className="context-card form-stack" onSubmit={save}>
        <FormField id="contact-email" label="بريد التواصل" type="email" value={email} onChange={setEmail} direction="ltr" />
        <FormField id="phone" label="الهاتف" type="tel" value={phone} onChange={setPhone} direction="ltr" />
        <FormField id="address" label="العنوان" value={address} onChange={setAddress} />
        <button className="button button-primary" disabled={busy}>{busy ? "جارٍ الحفظ…" : "حفظ الإعدادات"}</button>
      </form>
    </main>
  </div>;
}
