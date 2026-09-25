"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, responseFieldErrors, responseMessage } from "@/lib/client-api";

type Step = "credentials" | "challenge";

export function LoginForm({ expired }: { expired: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setFieldErrors({});
    setBusy(true);
    try {
      const response = await centerRequest("auth/login", "POST", { email, password });
      setPassword("");
      if (!response.ok) {
        setFieldErrors(await responseFieldErrors(response));
        setError(await responseMessage(response));
        return;
      }
      const data: { status: string } = await response.json();
      if (data.status === "authenticated") {
        router.replace("/admin");
        router.refresh();
        return;
      }
      if (data.status === "mfa_challenge_required") {
        setStep("challenge");
        return;
      }
      setError("تعذر إكمال الدخول. حاول مرة أخرى.");
    } catch {
      setError("تعذر الاتصال بالمركز. تحقق من الاتصال وحاول مرة أخرى.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setFieldErrors({});
    setBusy(true);
    try {
      const response = await centerRequest("auth/mfa/challenge", "POST", useRecovery ? { recovery_code: recoveryCode } : { code });
      if (!response.ok) {
        setFieldErrors(await responseFieldErrors(response));
        setCode(""); setRecoveryCode("");
        setError(await responseMessage(response));
        return;
      }
      router.replace("/admin");
      router.refresh();
    } catch {
      setError("تعذر التحقق من الرمز. حاول مرة أخرى.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <span className="eyebrow">دخول المركز</span>
      <h1>{step === "credentials" ? "أهلًا بك في مركزك" : "تحقق من هويتك"}</h1>
      <p className="muted">
        {step === "credentials" ? "استخدم بريد عضويتك وكلمة المرور للمتابعة." : "أدخل الرمز الحالي من تطبيق المصادقة."}
      </p>
      {expired && step === "credentials" && !error ? <InlineNotice tone="warning">انتهت جلسة الدخول. سجّل الدخول من جديد.</InlineNotice> : null}
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}

      {step === "credentials" ? (
        <form className="form-stack" noValidate onSubmit={submitCredentials}>
          <FormField id="email" label="البريد الإلكتروني" type="email" value={email} onChange={(value) => { setEmail(value); setFieldErrors({}); }} error={fieldErrors.email} autoComplete="username" required direction="ltr" />
          <FormField id="password" label="كلمة المرور" type="password" value={password} onChange={(value) => { setPassword(value); setFieldErrors({}); }} error={fieldErrors.password} autoComplete="current-password" required />
          <button className="button button-primary" type="submit" disabled={busy || !email || !password}>{busy ? "جارٍ التحقق…" : "دخول المركز"}</button>
          <a className="text-link" href="/forgot-password">نسيت كلمة المرور؟</a>
        </form>
      ) : (
        <>
          <form className="form-stack" noValidate onSubmit={submitCode}>
            {useRecovery ? <FormField id="recovery-code" label="رمز الاستعادة" value={recoveryCode} onChange={(value) => { setRecoveryCode(value); setFieldErrors({}); }} error={fieldErrors.recovery_code} required direction="ltr" hint="كل رمز استعادة يُستخدم مرة واحدة" /> :
              <FormField id="code" label="رمز التحقق" value={code} onChange={(value) => { setCode(value); setFieldErrors({}); }} error={fieldErrors.code} autoComplete="one-time-code" required direction="ltr" hint="ستة أرقام من تطبيق المصادقة" />}
            <button className="button button-primary" type="submit" disabled={busy || (useRecovery ? !recoveryCode : !/^\d{6}$/.test(code))}>{busy ? "جارٍ التحقق…" : "تحقق وادخل"}</button>
          </form>
          <button className="text-link" type="button" onClick={() => { setUseRecovery(!useRecovery); setCode(""); setRecoveryCode(""); }}>{useRecovery ? "استخدام تطبيق المصادقة" : "استخدام رمز استعادة"}</button>
        </>
      )}
      <p className="auth-footnote">لا تملك دعوة؟ اطلبها من مالك المركز أو مسؤوله.</p>
    </AuthShell>
  );
}
