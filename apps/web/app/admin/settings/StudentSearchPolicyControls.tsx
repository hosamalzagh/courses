"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { InlineNotice } from "@/components/InlineNotice";
import { SettingsRow } from "@/components/SettingsRow";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { centerRequest, responseMessage } from "@/lib/client-api";
import type { CenterContext, StudentSearchPolicy } from "@/lib/server-context";

export function StudentSearchPolicyControls({ initialPolicy }: { initialPolicy: StudentSearchPolicy }) {
  const router = useRouter();
  const prefix = useId();
  const saving = useRef(false);
  const [policy, setPolicy] = useState(initialPolicy);
  const [confirmation, setConfirmation] = useState<"search" | "default" | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingChoice, setPendingChoice] = useState<"search" | "default" | null>(null);

  async function reload() {
    if (saving.current) return;
    saving.current = true; setBusy(true);
    try {
      const response = await centerRequest("user?include=student-settings", "GET");
      if (!response.ok) throw new Error(await responseMessage(response));
      const data = await response.json() as CenterContext;
      if (!data.student_search_policy) throw new Error("missing policy");
      setPolicy(data.student_search_policy); setConflict(false); setError(""); setNotice("حُمّل أحدث إعداد للبحث والمشاركة.");
      router.refresh();
    } catch { setError("تعذر تحميل الإعداد الحالي. حاول مرة أخرى."); }
    finally { saving.current = false; setBusy(false); }
  }

  async function save() {
    if (saving.current || !confirmation) return;
    const choice = confirmation;
    saving.current = true; setPendingChoice(choice); setConfirmation(null); setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest("student-search-policy", "PATCH", {
        ...(choice === "default" ? { default_sharing_enabled: !policy.default_sharing_enabled } : { enabled: !policy.enabled }),
        revision: policy.revision,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setError("تغيّر إعداد البحث. حمّل أحدث إعداد قبل التعديل."); }
        else setError(await responseMessage(response));
        return;
      }
      const data = await response.json() as { policy: StudentSearchPolicy };
      setPolicy(data.policy); setConflict(false);
      router.refresh();
    } catch { setConflict(true); setError("تعذر التأكد من حفظ الإعداد. حمّل أحدث حالة قبل المحاولة مجددًا."); }
    finally { saving.current = false; setPendingChoice(null); setBusy(false); }
  }

  return <>
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    <CenterHeaderActions>{conflict ? <Button disabled={busy} onClick={reload}>تحميل أحدث إعداد للبحث</Button> : null}</CenterHeaderActions>
    <div className="settings-list">
      <SettingsRow title="البحث بين الفروع" description="إتاحة العثور على بيانات الطلاب الأساسية خارج الفروع المسندة، لمن يملك صلاحية البحث المستقلة.">
        <Field orientation="horizontal" data-disabled={busy || conflict}>
          <Checkbox id={`${prefix}-search-enabled`} checked={policy.enabled} disabled={busy || conflict} aria-busy={pendingChoice === "search" || undefined} aria-describedby={`${prefix}-search-state`} onCheckedChange={() => setConfirmation("search")} />
          <FieldContent>
            <FieldLabel htmlFor={`${prefix}-search-enabled`}>تفعيل البحث بين الفروع</FieldLabel>
            <FieldDescription id={`${prefix}-search-state`} aria-live="polite">{pendingChoice === "search" ? "جارٍ حفظ التغيير…" : `الحالة: ${policy.enabled ? "مفعّل" : "مغلق"}`}</FieldDescription>
          </FieldContent>
        </Field>
      </SettingsRow>
      <SettingsRow title="مشاركة الملفات الجديدة" description="الاختيار الافتراضي عند إنشاء طالب جديد. لا يغيّر مشاركة الطلاب الموجودين.">
        <Field orientation="horizontal" data-disabled={busy || conflict}>
          <Checkbox id={`${prefix}-default-sharing`} checked={policy.default_sharing_enabled} disabled={busy || conflict} aria-busy={pendingChoice === "default" || undefined} aria-describedby={`${prefix}-sharing-state`} onCheckedChange={() => setConfirmation("default")} />
          <FieldContent>
            <FieldLabel htmlFor={`${prefix}-default-sharing`}>السماح بمشاركة الملفات الجديدة</FieldLabel>
            <FieldDescription id={`${prefix}-sharing-state`} aria-live="polite">{pendingChoice === "default" ? "جارٍ حفظ التغيير…" : `الحالة: ${policy.default_sharing_enabled ? "مسموحة" : "مغلقة"}`}</FieldDescription>
          </FieldContent>
        </Field>
      </SettingsRow>
    </div>
    {confirmation ? <ConfirmationDialog
      title={confirmation === "default" ? "تغيير افتراضي مشاركة الملفات الجديدة" : policy.enabled ? "تعطيل البحث بين الفروع" : "تفعيل البحث بين الفروع"}
      description={confirmation === "default" ? "سيطبق الاختيار الجديد عند إنشاء ملفات جديدة فقط. تبقى اختيارات الطلاب الموجودين محفوظة." : policy.enabled ? "سيتوقف البحث خارج الفروع المسندة. تبقى ملفات الطلاب وتاريخهم محفوظين." : "سيظهر الاسم ورقم الطالب ورقم التواصل للطلاب الذين يسمحون بالمشاركة، لمن يملك صلاحية البحث المستقلة. لا تُفتح سجلاتهم أو صلاحية تعديلهم."}
      confirmLabel={confirmation === "default" ? policy.default_sharing_enabled ? "غلق المشاركة للملفات الجديدة" : "السماح بالمشاركة للملفات الجديدة" : policy.enabled ? "تعطيل البحث" : "تفعيل البحث"}
      onCancel={() => setConfirmation(null)} onConfirm={save}
    /> : null}
  </>;
}
