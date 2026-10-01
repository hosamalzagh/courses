"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { FieldGroup } from "@/components/ui/field";
import { Button } from "@/components/Button";
import { useWorkspaceRouter as useRouter } from "@/components/WorkspaceNavigation";
import { CenterPageActions } from "@/components/CenterShell";
import type { CenterContext } from "@/lib/server-context";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { SettingsRow } from "@/components/SettingsRow";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { centerRequest, responseFieldErrors, responseMessage } from "@/lib/client-api";

type Settings = import('@/lib/server-context').CenterSettings;

export function SettingsControls({ context, initialSettings }: { context: CenterContext; initialSettings: Settings }) {
  const formPrefix = useId();
  const router = useRouter();
  const saving = useRef(false);
  const [saved, setSaved] = useState({ email: initialSettings.contact_email ?? "", phone: initialSettings.phone ?? "", address: initialSettings.address ?? "" });
  const [email, setEmail] = useState(initialSettings.contact_email ?? "");
  const [phone, setPhone] = useState(initialSettings.phone ?? "");
  const [address, setAddress] = useState(initialSettings.address ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const dirty = email !== saved.email || phone !== saved.phone || address !== saved.address;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(""); setFieldErrors({}); setNotice("");
    try {
      const response = await centerRequest("settings", "PATCH", {
        contact_email: email || null, phone: phone || null, address: address || null,
      });
      if (!response.ok) {
        setFieldErrors(await responseFieldErrors(response));
        throw new Error(await responseMessage(response));
      }
      setSaved({ email, phone, address });
      setNotice("حُفظت إعدادات المركز.");
      router.refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر حفظ الإعدادات."); }
    finally { saving.current = false; setBusy(false); }
  }

  return <>
    <CenterPageActions context={context} actions={dirty ? <Button variant="primary" form={`${formPrefix}-0`} disabled={busy} type="submit" busy={busy} busyLabel="جارٍ الحفظ…">حفظ الإعدادات</Button> : null} />
      <UnsavedChangesGuard dirty={dirty} guardHistory />
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      <form id={`${formPrefix}-0`} className="settings-list" noValidate onSubmit={save}>
        <FieldGroup>
          <SettingsRow title="اسم المركز" description="الاسم المسجل للمركز ويظهر في مساحة الإدارة.">
            <p><strong>{context.center.name}</strong></p>
          </SettingsRow>
          <SettingsRow title="بريد التواصل" description="البريد الذي يستخدمه المركز للتواصل مع الطلاب وأولياء الأمور.">
            <FormField id={`${formPrefix}-email`} label="بريد التواصل" type="email" value={email} onChange={(value) => { setEmail(value); setError(""); setFieldErrors({}); }} error={fieldErrors.contact_email} direction="ltr" />
          </SettingsRow>
          <SettingsRow title="هاتف المركز" description="رقم التواصل الرئيسي للمركز.">
            <FormField id={`${formPrefix}-phone`} label="الهاتف" type="tel" value={phone} onChange={(value) => { setPhone(value); setError(""); setFieldErrors({}); }} error={fieldErrors.phone} direction="ltr" />
          </SettingsRow>
          <SettingsRow title="عنوان المركز" description="العنوان العام للمركز؛ لكل فرع عنوانه الخاص في تبويب الفروع.">
            <FormField id={`${formPrefix}-address`} label="العنوان" value={address} onChange={(value) => { setAddress(value); setError(""); setFieldErrors({}); }} error={fieldErrors.address} />
          </SettingsRow>
        </FieldGroup>
      </form>
  </>;
}
