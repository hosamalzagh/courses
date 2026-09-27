"use client";

import { Button } from "@/components/Button";
import { FieldGroup } from "@/components/ui/field";


import { PrefetchLink } from "@/components/PrefetchLink";

import { useState, type FormEvent } from "react";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, responseFieldErrors, responseMessage } from "@/lib/client-api";

export function ResetPasswordForm({ token, initialEmail }: { token: string; initialEmail: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setFieldErrors({});
    if (password.length < 12 || password !== confirmation) {
      setFieldErrors(password.length < 12 ? { password: "استخدم 12 حرفًا على الأقل." } : { password_confirmation: "تأكيد كلمة المرور غير مطابق." });
      return;
    }
    setBusy(true);
    try {
      const response = await centerRequest("auth/reset-password", "POST", { email, token, password, password_confirmation: confirmation });
      if (!response.ok) {
        setFieldErrors(await responseFieldErrors(response));
        throw new Error(await responseMessage(response));
      }
      setDone(true); setPassword(""); setConfirmation("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر استعادة كلمة المرور."); }
    finally { setBusy(false); }
  }

  return <><span className="eyebrow">استعادة الدخول</span><h1>عيّن كلمة مرور جديدة</h1>
    {done ? <InlineNotice>حُفظت كلمة المرور. يمكنك الدخول الآن.</InlineNotice> : null}
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {!done ? <form className="form-stack" noValidate onSubmit={submit}>
<FieldGroup>
      <FormField id="email" label="البريد الإلكتروني" type="email" value={email} onChange={(value) => { setEmail(value); setFieldErrors({}); }} error={fieldErrors.email} direction="ltr" required />
      <FormField id="password" label="كلمة المرور الجديدة" type="password" value={password} onChange={(value) => { setPassword(value); setFieldErrors({}); }} error={fieldErrors.password} autoComplete="new-password" required />
      <FormField id="confirmation" label="تأكيد كلمة المرور" type="password" value={confirmation} onChange={(value) => { setConfirmation(value); setFieldErrors({}); }} error={fieldErrors.password_confirmation} autoComplete="new-password" required />
      <Button type="submit" variant="primary" disabled={busy || !email || !password || !confirmation} busy={busy} busyLabel="جارٍ الحفظ…">حفظ كلمة المرور</Button>
    </FieldGroup>
</form> : null}
    <p className="auth-footnote"><PrefetchLink className="text-link" href="/login">العودة إلى الدخول</PrefetchLink></p>
  </>;
}
