"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";
import type { StudyEnrollmentContext } from "@/lib/server-context";

type Attempt = StudyEnrollmentContext["attempts"][number];

export function StudyWithdrawalEditor({ studentId, attempt, onClose, onSaved, onDirtyChange }: {
  studentId: string; attempt: Attempt; onClose: () => void; onSaved: (attempt: Attempt) => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const router = useRouter();
  const prefix = useId();
  const formId = `${prefix}-withdrawal`;
  const [withdrawnOn, setWithdrawnOn] = useState("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  const dirty = Boolean(withdrawnOn || reason);
  useEffect(() => {
    const frame = requestAnimationFrame(() => document.getElementById(`${prefix}-date`)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [prefix]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  function validate(): boolean {
    if (!withdrawnOn || withdrawnOn < attempt.joined_on) {
      setError("أدخل تاريخ انسحاب لا يسبق تاريخ الانضمام.");
      document.getElementById(`${prefix}-date`)?.focus(); return false;
    }
    if (!reason.trim() || reason.trim().length > 2000) {
      setError("أدخل سبب الانسحاب حتى ٢٠٠٠ حرف.");
      document.getElementById(`${prefix}-reason`)?.focus(); return false;
    }
    return true;
  }

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy && !conflict && validate()) setConfirm(true);
  }

  async function save() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setConfirm(false); setError("");
    try {
      requestId.current ??= newSubmissionId();
      const response = await centerRequest(`students/${studentId}/enrollments/${attempt.id}/withdraw`, "POST", {
        withdrawn_on: withdrawnOn, reason: reason.trim(), revision: attempt.revision, request_id: requestId.current,
      });
      if (!response.ok) {
        if (response.status === 409) {
          setConflict(true); setUncertain(false);
          setError("تغيرت محاولة الدراسة منذ فتحها. حدّث الصفحة قبل اتخاذ قرار آخر.");
        } else setError(await responseMessage(response));
        return;
      }
      const result = await response.json() as { attempt: Attempt };
      onSaved(result.attempt); onDirtyChange(false); onClose(); router.refresh();
    } catch {
      setUncertain(true);
      setError("تعذر التأكد من الانسحاب. أعد الطلب نفسه للتحقق دون تكرار القرار.");
    } finally { submitting.current = false; setBusy(false); }
  }

  return <section className="context-card form-stack" aria-label={`انسحاب من ${attempt.group_name}`}>
    <h2>انسحاب من {attempt.group_name}</h2>
    <p className="muted">يغلق الانسحاب ارتباط الطالب بالمجموعة في التاريخ المحدد. تبقى المحاولة والحضور والرسوم والدفعات محفوظة. أي تسوية أو استرداد مالي يتطلب إجراءً مستقلًا.</p>
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    <form id={formId} onSubmit={prepare} noValidate><FieldGroup>
      <FormField id={`${prefix}-date`} label="تاريخ الانسحاب" type="date" value={withdrawnOn} onChange={setWithdrawnOn} disabled={busy || uncertain || conflict} />
      <Field data-invalid={Boolean(error && !reason.trim())}>
        <FieldLabel htmlFor={`${prefix}-reason`}>سبب الانسحاب</FieldLabel>
        <Textarea id={`${prefix}-reason`} value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} disabled={busy || uncertain || conflict} aria-invalid={Boolean(error && !reason.trim())} />
        {error && !reason.trim() ? <FieldError>السبب مطلوب.</FieldError> : null}
      </Field>
    </FieldGroup></form>
    <CenterHeaderActions>
      <Button form={formId} type="submit" variant="primary" busy={busy} disabled={conflict}>{uncertain ? "التحقق من الانسحاب" : "اعتماد الانسحاب"}</Button>
      <Button type="button" disabled={busy || uncertain} onClick={onClose}>إلغاء الانسحاب</Button>
      {conflict ? <Button type="button" onClick={() => { onClose(); router.refresh(); }}>تحميل أحدث البيانات</Button> : null}
    </CenterHeaderActions>
    {confirm ? <ConfirmationDialog title="تأكيد الانسحاب" description={`سيغلق ارتباط الطالب بمجموعة ${attempt.group_name} بتاريخ ${withdrawnOn}. تبقى الرسوم والحركات المالية كما هي.`}
      confirmLabel="تأكيد الانسحاب" onCancel={() => setConfirm(false)} onConfirm={save} /> : null}
  </section>;
}
