"use client";

import { Button } from "@/components/Button";
import { FieldGroup } from "@/components/ui/field";


import { PrefetchLink } from "@/components/PrefetchLink";

import { useState, type FormEvent } from "react";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, responseFieldErrors, responseMessage } from "@/lib/client-api";

export function ForgotPasswordForm() {
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

  return <><span className="eyebrow">استعادة الدخول</span><h1>نسيت كلمة المرور؟</h1>
    <p className="muted">أدخل بريدك. إذا كان الحساب موجودًا، ستصلك رسالة لاستعادة الدخول.</p>
    {sent ? <InlineNotice>إذا كان الحساب موجودًا، أُرسلت رسالة الاستعادة.</InlineNotice> : null}
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    <form className="form-stack" noValidate onSubmit={submit}>
<FieldGroup><FormField id="email" label="البريد الإلكتروني" type="email" value={email} onChange={(value) => { setEmail(value); setFieldErrors({}); }} error={fieldErrors.email} direction="ltr" required />
      <Button type="submit" variant="primary" disabled={busy || !email} busy={busy} busyLabel="جارٍ الإرسال…">إرسال رابط الاستعادة</Button></FieldGroup>
</form>
    <p className="auth-footnote"><PrefetchLink className="text-link" href="/login">العودة إلى الدخول</PrefetchLink></p>
  </>;
}
