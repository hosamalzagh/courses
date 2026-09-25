"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { AuthShell } from "@/components/AuthShell";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, responseMessage } from "@/lib/client-api";

type Step = "credentials" | "setup" | "challenge";

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [secret, setSecret] = useState("");
  const [otpauthUrl, setOtpauthUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await centerRequest("auth/login", "POST", { email, password });
      setPassword("");
      if (!response.ok) {
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
      const setup = await centerRequest("auth/mfa/setup", "POST");
      if (!setup.ok) {
        setError(await responseMessage(setup));
        return;
      }
      const details: { secret: string; otpauth_url: string } = await setup.json();
      setSecret(details.secret);
      setOtpauthUrl(details.otpauth_url);
      setStep("setup");
    } catch {
      setError("تعذر الاتصال بالمركز. تحقق من الاتصال وحاول مرة أخرى.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const path = step === "setup" ? "auth/mfa/confirm" : "auth/mfa/challenge";
      const response = await centerRequest(path, "POST", { code });
      if (!response.ok) {
        setCode("");
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
      <h1>{step === "credentials" ? "أهلًا بك في مركزك" : step === "setup" ? "فعّل الحماية الإضافية" : "تحقق من هويتك"}</h1>
      <p className="muted">
        {step === "credentials" ? "استخدم بريد عضويتك وكلمة المرور للمتابعة." : step === "setup" ? "امسح الرمز في تطبيق المصادقة، ثم أدخل الرقم الظاهر فيه." : "أدخل الرمز الحالي من تطبيق المصادقة."}
      </p>
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}

      {step === "credentials" ? (
        <form className="form-stack" noValidate onSubmit={submitCredentials}>
          <FormField id="email" label="البريد الإلكتروني" type="email" value={email} onChange={setEmail} autoComplete="username" required direction="ltr" />
          <FormField id="password" label="كلمة المرور" type="password" value={password} onChange={setPassword} autoComplete="current-password" required />
          <button className="button button-primary" type="submit" disabled={busy || !email || !password}>{busy ? "جارٍ التحقق…" : "دخول المركز"}</button>
          <a className="text-link" href="/forgot-password">نسيت كلمة المرور؟</a>
        </form>
      ) : (
        <>
          {step === "setup" ? (
            <div>
              <div className="qr-wrap"><QRCodeSVG value={otpauthUrl} size={168} aria-label="رمز إعداد تطبيق المصادقة" /></div>
              <p className="muted">إذا تعذّر مسح الرمز، أدخل هذا المفتاح في التطبيق:</p>
              <div className="mfa-secret" aria-label="مفتاح المصادقة">{secret}</div>
            </div>
          ) : null}
          <form className="form-stack" noValidate onSubmit={submitCode}>
            <FormField id="code" label="رمز التحقق" value={code} onChange={setCode} autoComplete="one-time-code" required direction="ltr" hint="ستة أرقام من تطبيق المصادقة" />
            <button className="button button-primary" type="submit" disabled={busy || !/^\d{6}$/.test(code)}>{busy ? "جارٍ التحقق…" : "تحقق وادخل"}</button>
          </form>
        </>
      )}
      <p className="auth-footnote">لا تملك دعوة؟ اطلبها من مالك المركز أو مسؤوله.</p>
    </AuthShell>
  );
}
