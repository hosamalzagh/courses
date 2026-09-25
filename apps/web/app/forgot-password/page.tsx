"use client";

import { useState, type FormEvent } from "react";
import { AuthShell } from "@/components/AuthShell";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, responseFieldErrors, responseMessage } from "@/lib/client-api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setFieldErrors({});
    try {
      const response = await centerRequest("auth/forgot-password", "POST", { email });
      if (!response.ok) {
        setFieldErrors(await responseFieldErrors(response));
        throw new Error(await responseMessage(response));
      }
      setSent(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر إرسال الطلب."); }
    finally { setBusy(false); }
  }

  return <AuthShell><span className="eyebrow">استعادة الدخول</span><h1>نسيت كلمة المرور؟</h1>
    <p className="muted">أدخل بريدك. إذا كان الحساب موجودًا، ستصلك رسالة لاستعادة الدخول.</p>
    {sent ? <InlineNotice>إذا كان الحساب موجودًا، أُرسلت رسالة الاستعادة.</InlineNotice> : null}
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    <form className="form-stack" noValidate onSubmit={submit}><FormField id="email" label="البريد الإلكتروني" type="email" value={email} onChange={(value) => { setEmail(value); setFieldErrors({}); }} error={fieldErrors.email} direction="ltr" required />
      <button className="button button-primary" disabled={busy || !email}>{busy ? "جارٍ الإرسال…" : "إرسال رابط الاستعادة"}</button></form>
    <p className="auth-footnote"><a className="text-link" href="/login">العودة إلى الدخول</a></p>
  </AuthShell>;
}
