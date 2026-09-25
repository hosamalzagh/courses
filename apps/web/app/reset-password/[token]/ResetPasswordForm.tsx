"use client";

import { useState, type FormEvent } from "react";
import { AuthShell } from "@/components/AuthShell";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, responseMessage } from "@/lib/client-api";

export function ResetPasswordForm({ token, initialEmail }: { token: string; initialEmail: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (password.length < 12 || password !== confirmation) {
      setError("استخدم كلمة مرور من 12 حرفًا على الأقل، وتأكد من تطابقها."); return;
    }
    setBusy(true);
    try {
      const response = await centerRequest("auth/reset-password", "POST", { email, token, password, password_confirmation: confirmation });
      if (!response.ok) throw new Error(await responseMessage(response));
      setDone(true); setPassword(""); setConfirmation("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر استعادة كلمة المرور."); }
    finally { setBusy(false); }
  }

  return <AuthShell><span className="eyebrow">استعادة الدخول</span><h1>عيّن كلمة مرور جديدة</h1>
    {done ? <InlineNotice>حُفظت كلمة المرور. يمكنك الدخول الآن.</InlineNotice> : null}
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {!done ? <form className="form-stack" onSubmit={submit}>
      <FormField id="email" label="البريد الإلكتروني" type="email" value={email} onChange={setEmail} direction="ltr" required />
      <FormField id="password" label="كلمة المرور الجديدة" type="password" value={password} onChange={setPassword} autoComplete="new-password" required />
      <FormField id="confirmation" label="تأكيد كلمة المرور" type="password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" required />
      <button className="button button-primary" disabled={busy || !email || !password || !confirmation}>{busy ? "جارٍ الحفظ…" : "حفظ كلمة المرور"}</button>
    </form> : null}
    <p className="auth-footnote"><a className="text-link" href="/login">العودة إلى الدخول</a></p>
  </AuthShell>;
}
