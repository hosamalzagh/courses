"use client";

import { Button } from "@/components/Button";
import { useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import { CenterShell } from "@/components/CenterShell";
import type { CenterContext } from "@/lib/server-context";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { centerRequest, responseFieldErrors, responseMessage } from "@/lib/client-api";

export function SecurityWorkspace({ context, email, initialEnabled, requiredForPlatform }: {
  context: CenterContext;
  email: string;
  initialEnabled: boolean;
  requiredForPlatform: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [setupPassword, setSetupPassword] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [secret, setSecret] = useState("");
  const [otpauthUrl, setOtpauthUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [confirmDisable, setConfirmDisable] = useState(false);

  async function startSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setFieldErrors({}); setNotice("");
    try {
      const response = await centerRequest("security/mfa/setup", "POST", { password: setupPassword });
      if (!response.ok) {
        setFieldErrors(await responseFieldErrors(response));
        throw new Error(await responseMessage(response));
      }
      const data: { secret: string; otpauth_url: string } = await response.json();
      setSecret(data.secret); setOtpauthUrl(data.otpauth_url); setSetupPassword(""); setCode("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر بدء الإعداد."); }
    finally { setBusy(false); }
  }

  async function confirmSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setFieldErrors({}); setNotice("");
    try {
      const response = await centerRequest("security/mfa/confirm", "POST", { code });
      if (!response.ok) {
        setFieldErrors(await responseFieldErrors(response));
        throw new Error(response.status === 410 ? "انتهت مهلة الإعداد. ابدأ من جديد." : await responseMessage(response));
      }
      const data: { recovery_codes: string[] } = await response.json();
      setEnabled(true); setSecret(""); setOtpauthUrl(""); setCode("");
      setRecoveryCodes(data.recovery_codes);
      setNotice("فُعّل التحقق بخطوتين لحسابك. سيُطلب الرمز عند دخول أي مركز.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر تفعيل التحقق."); }
    finally { setBusy(false); }
  }

  async function cancelSetup() {
    setBusy(true); setError("");
    try {
      await centerRequest("security/mfa/cancel", "POST");
      setSecret(""); setOtpauthUrl(""); setCode("");
    } catch { setError("تعذر إلغاء الإعداد. أعد تحميل الصفحة."); }
    finally { setBusy(false); }
  }

  function requestDisable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConfirmDisable(true);
  }

  async function disable() {
    setBusy(true); setError(""); setFieldErrors({}); setNotice("");
    try {
      const response = await centerRequest("security/mfa/disable", "POST", {
        password: disablePassword, ...(useRecovery ? { recovery_code: recoveryCode } : { code }),
      });
      if (!response.ok) {
        setFieldErrors(await responseFieldErrors(response));
        throw new Error(await responseMessage(response));
      }
      setEnabled(false); setDisablePassword(""); setCode(""); setRecoveryCode(""); setRecoveryCodes([]);
      setNotice("أُوقف التحقق بخطوتين. يمكنك تفعيله مجددًا في أي وقت.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر إيقاف التحقق."); }
    finally { setBusy(false); }
  }

  return <CenterShell context={context} title="التحقق بخطوتين" description={<>حسابك <bdi dir="ltr">{email}</bdi> مشترك بين المراكز. التفعيل اختياري ويطبق على دخولك إلى جميعها.</>}>
    <main className="members-main">

      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      <section className="context-card form-stack">
        <h2>{enabled ? "التحقق بخطوتين مفعّل" : "التحقق بخطوتين غير مفعّل"}</h2>
        {enabled ? <>
          {recoveryCodes.length > 0 ? <div className="context-card form-stack" aria-label="رموز الاستعادة">
            <h3>احفظ رموز الاستعادة الآن</h3>
            <p className="muted">تظهر هذه الرموز مرة واحدة فقط. احفظها في مكان آمن؛ كل رمز يعمل مرة واحدة إذا فقدت تطبيق المصادقة.</p>
            <div className="role-list">{recoveryCodes.map((item) => <code className="role-pill" dir="ltr" key={item}>{item}</code>)}</div>
            <Button variant="secondary" type="button" onClick={() => setRecoveryCodes([])}>حفظت الرموز</Button>
          </div> : null}
          <p className="muted">عند تسجيل الدخول سيُطلب رمز من تطبيق المصادقة بعد كلمة المرور.</p>
          {requiredForPlatform ? <p className="muted">هذا الحساب يدخل لوحة المنصة، لذلك يبقى التحقق مطلوبًا لها ولا يمكن إيقافه من المركز.</p> :
            <form className="form-stack" noValidate onSubmit={requestDisable}>
              <FormField id="disable-password" label="كلمة المرور الحالية" type="password" value={disablePassword} onChange={(value) => { setDisablePassword(value); setFieldErrors({}); }} error={fieldErrors.password} autoComplete="current-password" required />
              {useRecovery ? <FormField id="disable-recovery" label="رمز الاستعادة" value={recoveryCode} onChange={(value) => { setRecoveryCode(value); setFieldErrors({}); }} error={fieldErrors.recovery_code} direction="ltr" required /> :
                <FormField id="disable-code" label="رمز المصادقة الحالي" value={code} onChange={(value) => { setCode(value); setFieldErrors({}); }} error={fieldErrors.code} autoComplete="one-time-code" direction="ltr" required />}
              <button className="text-link" type="button" onClick={() => { setUseRecovery(!useRecovery); setCode(""); setRecoveryCode(""); }}>{useRecovery ? "استخدام تطبيق المصادقة" : "استخدام رمز استعادة"}</button>
              <div className="form-actions"><Button variant="danger" disabled={busy || !disablePassword || (useRecovery ? !recoveryCode : !/^\d{6}$/.test(code))} type="submit" busy={busy} busyLabel="جارٍ الإيقاف…">إيقاف التحقق بخطوتين</Button></div>
            </form>}
        </> : secret ? <>
          <p className="muted">امسح الرمز بتطبيق المصادقة، ثم أدخل الرقم الظاهر فيه. تنتهي مهلة الإعداد بعد 10 دقائق.</p>
          <div className="qr-wrap"><QRCodeSVG value={otpauthUrl} size={168} aria-label="رمز إعداد تطبيق المصادقة" /></div>
          <p className="muted">إذا تعذّر مسح الرمز، أدخل هذا المفتاح في التطبيق:</p>
          <div className="mfa-secret" aria-label="مفتاح المصادقة">{secret}</div>
          <form className="form-stack" noValidate onSubmit={confirmSetup}>
            <FormField id="setup-code" label="رمز التحقق" value={code} onChange={(value) => { setCode(value); setFieldErrors({}); }} error={fieldErrors.code} autoComplete="one-time-code" direction="ltr" required />
            <div className="form-actions"><Button variant="primary" disabled={busy || !/^\d{6}$/.test(code)} type="submit" busy={busy} busyLabel="جارٍ التفعيل…">تفعيل التحقق</Button><Button type="button" onClick={cancelSetup} disabled={busy}>إلغاء الإعداد</Button></div>
          </form>
        </> : <>
          <p className="muted">تدخل الآن بكلمة المرور فقط. يمكنك إضافة رمز المصادقة لحماية حسابك.</p>
          <form className="form-stack" noValidate onSubmit={startSetup}>
            <FormField id="setup-password" label="كلمة المرور الحالية" type="password" value={setupPassword} onChange={(value) => { setSetupPassword(value); setFieldErrors({}); }} error={fieldErrors.password} autoComplete="current-password" required />
            <div className="form-actions"><Button variant="primary" disabled={busy || !setupPassword} type="submit" busy={busy} busyLabel="جارٍ إعداد الحماية…">تفعيل التحقق بخطوتين</Button></div>
          </form>
        </>}
      </section>
    </main>
    {confirmDisable ? <ConfirmationDialog title="إيقاف التحقق بخطوتين؟" description="سيُلغى طلب رمز المصادقة عند دخولك إلى أي مركز." confirmLabel="إيقاف التحقق"
      onCancel={() => setConfirmDisable(false)} onConfirm={() => { setConfirmDisable(false); void disable(); }} /> : null}
  </CenterShell>;
}
