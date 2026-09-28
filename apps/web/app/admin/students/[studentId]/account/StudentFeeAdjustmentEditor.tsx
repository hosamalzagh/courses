"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { DataTable } from "@/components/DataTable";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";
import type { StudentFee } from "@/lib/server-context";

type Balance = { received_total: string; due_total: string; paid_total: string; allocated_total: string; available_balance: string; debt: string };
type Adjustment = { id: string; kind: "settlement" | "reversal"; amount_delta: string; before_due: string; after_due: string;
  reverses_id: string | null; replaces_id: string | null; reason: string; actor_name: string; created_at: string; reversal_id: string | null };
type Preview = { fee_before: string; fee_after: string; fee_paid_before: string; fee_paid_after: string; replaces_adjustment_id: string | null;
  account_before: Balance; account_after: Balance; released_allocations: { allocation_id: string; payment_id: string; released_amount: string; replacement_amount: string }[] };
type Detail = { fee: { id: string; attempt_id: string; branch_id: number; status: string; withdrawn_on: string | null;
  net_amount: string; current_due: string; paid_amount: string; currency: string }; version: string; can_approve: boolean;
  account: Balance; history: Adjustment[]; pagination: { history_page: number; history_has_more: boolean }; preview: Preview | null };

export function StudentFeeAdjustmentEditor({ studentId, fee, onClose, onChanged, onDirtyChange }: {
  studentId: string; fee: StudentFee; onClose: () => void; onChanged: () => Promise<void>; onDirtyChange: (dirty: boolean) => void;
}) {
  const prefix = useId();
  const formId = `${prefix}-fee-adjustment`;
  const path = `students/${studentId}/fees/${fee.id}/adjustments`;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [newDue, setNewDue] = useState("");
  const [reason, setReason] = useState("");
  const [replacesId, setReplacesId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  const dirty = Boolean(newDue || reason || replacesId);

  const load = useCallback(async (page = 1) => {
    setLoading(true); setError("");
    try {
      const response = await centerRequest(`${path}?history_page=${page}`, "GET");
      if (!response.ok) { setError(await responseMessage(response)); return; }
      setDetail(await response.json() as Detail); setConflict(false);
    } catch { setError("تعذر تحميل سجل الرسوم. تحقق من الاتصال وأعد المحاولة."); }
    finally { setLoading(false); }
  }, [path]);
  useEffect(() => { const timeout = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timeout); }, [load]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => document.getElementById(`${prefix}-title`)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [prefix]);
  useEffect(() => { onDirtyChange(dirty || uncertain); return () => onDirtyChange(false); }, [dirty, uncertain, onDirtyChange]);

  function changeDue(value: string) { setNewDue(value); setDetail(current => current ? { ...current, preview: null } : current); }
  function changeReason(value: string) { setReason(value); setDetail(current => current ? { ...current, preview: null } : current); }

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || busy || conflict || !detail.can_approve) return;
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(newDue)) {
      setError("أدخل مستحقًا غير سالب حتى منزلتين عشريتين."); document.getElementById(`${prefix}-new-due`)?.focus(); return;
    }
    if (!reason.trim()) { setError("أدخل سبب القرار المالي."); document.getElementById(`${prefix}-reason`)?.focus(); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const query = new URLSearchParams({ new_due: newDue, ...(replacesId ? { replaces_adjustment_id: replacesId } : {}) });
      const response = await centerRequest(`${path}?${query}`, "GET");
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setError("تغير تاريخ التسويات. حمّل أحدث الرسوم قبل القرار."); }
        else setError(await responseMessage(response));
        return;
      }
      setDetail(await response.json() as Detail);
      setNotice("راجع أثر القرار على المستحق والمسدد والرصيد قبل الاعتماد.");
    } catch { setError("تعذرت معاينة الأثر. تحقق من الاتصال وأعد المحاولة."); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!detail?.preview || submitting.current) return;
    submitting.current = true; setBusy(true); setConfirm(false); setError("");
    try {
      requestId.current ??= newSubmissionId();
      const response = await centerRequest(path, "POST", {
        new_due: newDue, reason: reason.trim(), replaces_adjustment_id: replacesId,
        version: detail.version, request_id: requestId.current,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setUncertain(false); setError("تغير الحساب أو التسوية. حمّل أحدث البيانات وراجع الأثر قبل الاعتماد."); }
        else { setUncertain(false); setError(await responseMessage(response)); }
        return;
      }
      requestId.current = null; setUncertain(false); onDirtyChange(false);
      await onChanged(); onClose();
    } catch {
      setUncertain(true); setError("تعذر التأكد من الاعتماد. احتفظ بالبيانات وأعد الطلب بالمفتاح نفسه دون تكرار الحركة.");
    } finally { submitting.current = false; setBusy(false); }
  }

  const latestActive = detail?.history.find(item => item.kind === "settlement" && !item.reversal_id);
  const currency = detail?.fee.currency ?? fee.currency;
  const preview = detail?.preview;
  return <section className="context-card form-stack" aria-labelledby={`${prefix}-title`}>
    <h2 id={`${prefix}-title`} tabIndex={-1}>تسوية رسوم {fee.group_name ?? "محاولة الدراسة"}</h2>
    <p className="muted">الرسوم الأصلية والتخصيصات المعتمدة تبقى في السجل. التخفيض الزائد على المسدد يعيد الفرق إلى رصيد الطالب المتاح، ولا يسجل ردًا نقديًا أو حضورًا.</p>
    {loading ? <p role="status">جارٍ تحميل الرسوم…</p> : null}
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {detail ? <>
      <p>الرسوم المسجلة: <bdi dir="ltr">{detail.fee.net_amount} {currency}</bdi> — المستحق الحالي: <strong><bdi dir="ltr">{detail.fee.current_due} {currency}</bdi></strong> — المسدد: <bdi dir="ltr">{detail.fee.paid_amount} {currency}</bdi></p>
      {detail.fee.withdrawn_on ? <p>انتهى الارتباط الدراسي في <bdi dir="ltr">{detail.fee.withdrawn_on}</bdi>. الانسحاب وحده لم يغير الرسوم.</p> : <p>هذه معالجة مالية صريحة لمحاولة دراسة قائمة.</p>}
      {replacesId ? <InlineNotice>تصحيح أحدث تسوية معتمدة. سيسجل عكسها وقرار بديل مع حفظ أصلها.</InlineNotice> : null}
      <form id={formId} onSubmit={prepare} noValidate><FieldGroup>
        <FormField id={`${prefix}-new-due`} label={`المستحق الجديد (${currency})`} type="text" direction="ltr" value={newDue} onChange={changeDue} disabled={busy || conflict || uncertain} />
        <Field data-invalid={Boolean(error && !reason.trim())}>
          <FieldLabel htmlFor={`${prefix}-reason`}>سبب التسوية أو التصحيح</FieldLabel>
          <Textarea id={`${prefix}-reason`} value={reason} onChange={event => changeReason(event.target.value)} maxLength={2000} disabled={busy || conflict || uncertain} />
          {error && !reason.trim() ? <FieldError>السبب مطلوب.</FieldError> : null}
        </Field>
      </FieldGroup></form>
      {preview ? <section className="context-card form-stack" aria-label="معاينة أثر التسوية">
        <h3>الأثر قبل الاعتماد</h3>
        <p>مستحق المحاولة: <bdi dir="ltr">{preview.fee_before}</bdi> ← <strong><bdi dir="ltr">{preview.fee_after} {currency}</bdi></strong></p>
        <p>المسدد للمحاولة: <bdi dir="ltr">{preview.fee_paid_before}</bdi> ← <bdi dir="ltr">{preview.fee_paid_after} {currency}</bdi></p>
        <p>إجمالي مستحق الطالب: <bdi dir="ltr">{preview.account_before.due_total}</bdi> ← <bdi dir="ltr">{preview.account_after.due_total} {currency}</bdi></p>
        <p>مديونية الطالب: <bdi dir="ltr">{preview.account_before.debt}</bdi> ← <bdi dir="ltr">{preview.account_after.debt} {currency}</bdi></p>
        <p>الرصيد المتاح: <bdi dir="ltr">{preview.account_before.available_balance}</bdi> ← <bdi dir="ltr">{preview.account_after.available_balance} {currency}</bdi></p>
        {preview.released_allocations.length ? <p>سيُعكس أثر {preview.released_allocations.length.toLocaleString("ar-EG")} تخصيص، مع حفظ الأصل وإعادة الجزء الذي لا يتجاوز المستحق الجديد.</p> : null}
      </section> : null}
      <CenterHeaderActions>
        <Button form={formId} type="submit" disabled={busy || conflict || uncertain} busy={busy}>معاينة الأثر</Button>
        {preview ? <Button variant="primary" disabled={busy || conflict} onClick={() => setConfirm(true)}>{uncertain ? "التحقق من الاعتماد" : replacesId ? "اعتماد التصحيح" : "اعتماد التسوية"}</Button> : null}
        {replacesId ? <Button disabled={busy || uncertain} onClick={() => { setReplacesId(null); setDetail(current => current ? { ...current, preview: null } : current); }}>إلغاء وضع التصحيح</Button> : null}
        <Button disabled={busy || uncertain} onClick={() => dirty ? setCancel(true) : onClose()}>إغلاق محرر الرسوم</Button>
        {conflict ? <Button disabled={busy} onClick={() => void load()}>تحميل أحدث الرسوم</Button> : null}
      </CenterHeaderActions>
      <DataTable id="student-fee-adjustments" title="تاريخ قرارات الرسوم" rows={detail.history} rowKey={row => row.id}
        searchText={row => `${row.reason} ${row.actor_name} ${row.amount_delta} ${row.after_due}`}
        emptyMessage="لا توجد تسوية معتمدة لهذه الرسوم." description="يبقى أصل كل قرار وعكسه وتصحيحه قابلًا للمراجعة."
        columns={[
          { key: "kind", label: "الحركة", render: row => row.kind === "reversal" ? "عكس تسوية" : row.replaces_id ? "تسوية بديلة" : "تسوية" },
          { key: "amount", label: "أثر الحركة", render: row => <bdi dir="ltr">{row.amount_delta} {currency}</bdi> },
          { key: "due", label: "المستحق بعدها", render: row => <bdi dir="ltr">{row.after_due} {currency}</bdi> },
          { key: "reason", label: "السبب", render: row => row.reason },
          { key: "actor", label: "اعتمدها", render: row => row.actor_name },
          { key: "actions", label: "الإجراءات", actions: true, render: row => row.id === latestActive?.id && !row.reversal_id ?
            <Button disabled={busy || conflict || uncertain} onClick={() => { setReplacesId(row.id); setNewDue(row.before_due); setDetail(current => current ? { ...current, preview: null } : current); document.getElementById(`${prefix}-new-due`)?.focus(); }}>تصحيح هذه التسوية</Button> : <span className="muted">محفوظة</span> },
        ]} />
      <CenterHeaderActions>
        {detail.pagination.history_page > 1 ? <Button disabled={busy || uncertain} onClick={() => void load(detail.pagination.history_page - 1)}>قرارات أحدث</Button> : null}
        {detail.pagination.history_has_more ? <Button disabled={busy || uncertain} onClick={() => void load(detail.pagination.history_page + 1)}>قرارات أقدم</Button> : null}
      </CenterHeaderActions>
    </> : null}
    {confirm && preview ? <ConfirmationDialog title={replacesId ? "تأكيد تصحيح التسوية" : "تأكيد تسوية الرسوم"}
      description={`سيتغير مستحق المحاولة من ${preview.fee_before} إلى ${preview.fee_after} ${currency}، ويبقى رد المال النقدي إجراءً مستقلاً.`}
      confirmLabel={replacesId ? "تأكيد التصحيح" : "تأكيد التسوية"} onCancel={() => setConfirm(false)} onConfirm={save} /> : null}
    {cancel ? <ConfirmationDialog title="إغلاق دون اعتماد" description="ستفقد بيانات التسوية التي لم تعتمدها."
      confirmLabel="إغلاق دون اعتماد" onCancel={() => setCancel(false)} onConfirm={() => { onDirtyChange(false); onClose(); }} /> : null}
  </section>;
}
