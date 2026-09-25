"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, responseMessage } from "@/lib/client-api";

type Invitation = { email: string; center: { name: string } };

export default function InvitationPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v1/center/invitations/${encodeURIComponent(params.token)}`, {
      cache: "no-store", credentials: "same-origin", signal: controller.signal,
      headers: { Accept: "application/json" },
    }).then(async (response) => {
      if (!response.ok) throw new Error(await responseMessage(response));
      return response.json();
    }).then(setInvitation).catch((failure) => {
      if (!controller.signal.aborted) setError(failure.message || "تعذر تحميل الدعوة.");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [params.token]);

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password.length < 12 || password !== confirmation) {
      setError("استخدم كلمة مرور من 12 حرفًا على الأقل، وتأكد من تطابقها.");
      return;
    }
    setBusy(true);
    try {
      const response = await centerRequest(`invitations/${encodeURIComponent(params.token)}`, "POST", {
        name, password, password_confirmation: confirmation,
      });
      if (!response.ok) {
        setError(await responseMessage(response));
        return;
      }
      router.replace("/login?invitation=accepted");
    } catch {
      setError("تعذر الاتصال بالمركز. حاول مرة أخرى.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell>
      <span className="eyebrow">دعوة المركز</span>
      <h1>ابدأ عضويتك</h1>
      {loading ? <InlineNotice>جارٍ تحميل الدعوة…</InlineNotice> : null}
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {invitation ? (
        <>
          <p className="muted">دُعيت إلى <strong>{invitation.center.name}</strong> بالبريد <bdi dir="ltr">{invitation.email}</bdi>.</p>
          <form className="form-stack" noValidate onSubmit={accept}>
            <FormField id="name" label="الاسم" value={name} onChange={setName} autoComplete="name" required />
            <FormField id="password" label="كلمة المرور" type="password" value={password} onChange={setPassword} autoComplete="new-password" hint="12 حرفًا على الأقل. إذا كان لك حساب سابق، أدخل كلمة مروره." required />
            <FormField id="password-confirmation" label="تأكيد كلمة المرور" type="password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" required />
            <button className="button button-primary" type="submit" disabled={busy || !name || !password || !confirmation}>{busy ? "جارٍ قبول الدعوة…" : "قبول الدعوة"}</button>
          </form>
        </>
      ) : null}
      <p className="auth-footnote"><a className="text-link" href="/login">العودة إلى الدخول</a></p>
    </AuthShell>
  );
}
