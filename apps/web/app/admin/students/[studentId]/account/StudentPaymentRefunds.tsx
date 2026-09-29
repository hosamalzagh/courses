"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { DataTable } from "@/components/DataTable";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { FieldGroup, FieldSet } from "@/components/ui/field";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";
import type { StudentPayment } from "@/lib/server-context";

type Refund = { id: string; amount: string; currency: string; refunded_on: string; reason: string;
  actor_name: string; created_at: string; reversal_id: string | null; correction_reason: string | null;
  corrected_by_name: string | null; corrected_at: string | null; replacement_refund_id: string | null;
  replacement_amount: string | null };
type PaymentBalance = { id: string; branch_id: number; branch_name: string; received_amount: string;
  received_on: string; allocated_amount: string; refunded_amount: string; available_before: string; currency: string };
type RefundOptions = { payment: PaymentBalance; version: string; can_refund: boolean; can_correct: boolean;
  history: Refund[]; pagination: { page: number; has_more: boolean } };
type RefundPreview = { payment: PaymentBalance; amount: string; refunded_on: string; reason: string;
  available_after: string; version: string };
type CorrectionPreview = { original: { id: string; amount: string; refunded_on: string; reason: string; actor_name: string };
  payment: PaymentBalance; correct_amount: string; available_after: string; version: string;
  later_movements: { id: number; event: string; created_at: string }[] };

const laterLabels: Record<string, string> = {
  "student.payment_allocated": "تخصيص دفعة", "student.payment_allocation_reversed": "عكس تخصيص",
  "student.payment_allocation_corrected": "تصحيح تخصيص", "student.refund_recorded": "استرداد فعلي",
  "student.refund_corrected": "تصحيح استرداد",
};

export function StudentPaymentRefunds({ studentId, payment, onClose, onChanged, onDirtyChange, onUncertainChange }: {
  studentId: string; payment: StudentPayment; onClose: () => void; onChanged: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void; onUncertainChange: (uncertain: boolean) => void;
}) {
  const prefix = useId();
  const refundForm = `${prefix}-refund-form`;
  const correctionForm = `${prefix}-correction-form`;
  const [options, setOptions] = useState<RefundOptions | null>(null);
  const [amount, setAmount] = useState("");
  const [refundedOn, setRefundedOn] = useState("");
  const [reason, setReason] = useState("");
  const [refundPreview, setRefundPreview] = useState<RefundPreview | null>(null);
  const [correcting, setCorrecting] = useState<Refund | null>(null);
  const [correctAmount, setCorrectAmount] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionPreview, setCorrectionPreview] = useState<CorrectionPreview | null>(null);
  const [confirmRefund, setConfirmRefund] = useState(false);
  const [confirmCorrection, setConfirmCorrection] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  const path = `students/${studentId}/payments/${payment.id}/refunds`;
  const dirty = Boolean(amount || refundedOn || reason || correctAmount || correctionReason);

  const load = useCallback(async (page = 1): Promise<RefundOptions | null> => {
    setLoading(true);
    try {
      const response = await centerRequest(`${path}?page=${page}`, "GET");
      if (!response.ok) { setError(await responseMessage(response)); return null; }
      const next = await response.json() as RefundOptions;
      setOptions(next);
      setConflict(false);
      return next;
    } catch { setError("تعذر تحميل سجل الاسترداد. تحقق من الاتصال وأعد المحاولة."); return null; }
    finally { setLoading(false); }
  }, [path]);

  useEffect(() => { const timeout = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timeout); }, [load]);
  useEffect(() => { onDirtyChange(dirty || uncertain); return () => onDirtyChange(false); }, [dirty, uncertain, onDirtyChange]);
  useEffect(() => { onUncertainChange(uncertain); return () => onUncertainChange(false); }, [uncertain, onUncertainChange]);

  function focus(id: string) { requestAnimationFrame(() => document.getElementById(id)?.focus()); }
  function changeRefund() { setRefundPreview(null); setError(""); requestId.current = null; }
  function changeCorrection() { setCorrectionPreview(null); setError(""); requestId.current = null; }

  async function reloadAfterConflict() {
    const latest = await load(options?.pagination.page);
    if (!latest) return;
    setRefundPreview(null);
    setCorrectionPreview(null);
    requestId.current = null;
    setError("");
    if (correcting) {
      const active = latest.history.find(row => row.id === correcting.id && !row.reversal_id);
      setCorrecting(active ?? null);
      if (!active) { setCorrectAmount(""); setCorrectionReason(""); }
    }
  }

  async function previewRefund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!options || busy || conflict) return;
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
      setError("أدخل مبلغًا موجبًا حتى منزلتين عشريتين."); focus(`${prefix}-amount`); return;
    }
    if (!refundedOn) { setError("أدخل تاريخ رد المبلغ فعليًا."); focus(`${prefix}-date`); return; }
    if (!reason.trim()) { setError("أدخل سبب الاسترداد."); focus(`${prefix}-reason`); return; }
    if (refundPreview) { setConfirmRefund(true); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`${path}/preview`, "POST", {
        amount, refunded_on: refundedOn, reason: reason.trim(), version: options.version,
      });
      if (!response.ok) {
        if (response.status === 409) setConflict(true);
        setError(response.status === 409 ? "تغير الرصيد المتاح. حمّل أحدث الحساب قبل الاسترداد." : await responseMessage(response));
        return;
      }
      setRefundPreview(await response.json() as RefundPreview);
      focus(`${prefix}-refund-preview`);
    } catch { setError("تعذرت معاينة الاسترداد. تحقق من الاتصال وأعد المحاولة."); }
    finally { setBusy(false); }
  }

  async function commitRefund() {
    if (!options || !refundPreview || submitting.current || conflict) return;
    submitting.current = true; setBusy(true); setError(""); setNotice("");
    let committed = false;
    try {
      requestId.current ??= newSubmissionId();
      const response = await centerRequest(path, "POST", {
        amount: refundPreview.amount, refunded_on: refundPreview.refunded_on, reason: refundPreview.reason,
        version: refundPreview.version, request_id: requestId.current,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setUncertain(false); setRefundPreview(null); setError("تغير الرصيد أو الطلب. حمّل أحدث الحساب وراجع الحركة."); }
        else if (response.status >= 500) { setUncertain(true); setError("تعذر التأكد من حفظ الرد النقدي. أعد المحاولة بالمفتاح نفسه."); }
        else { setUncertain(false); setError(await responseMessage(response)); }
        return;
      }
      committed = true; requestId.current = null; setUncertain(false);
      setAmount(""); setRefundedOn(""); setReason(""); setRefundPreview(null);
    } catch { setUncertain(true); setError("تعذر التأكد من حفظ الرد النقدي. أعد المحاولة بالمفتاح نفسه."); }
    finally { submitting.current = false; setBusy(false); }
    if (committed) {
      const refreshed = await Promise.allSettled([load(options.pagination.page), onChanged()]);
      setNotice(refreshed.some(result => result.status === "rejected" || result.value === null)
        ? "حُفظ الاسترداد، لكن تعذر تحديث الحساب. حمّل أحدث البيانات." : "سُجل المبلغ المعاد فعليًا مع السبب والفاعل.");
      focus(`${prefix}-amount`);
    }
  }

  async function previewCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!options || !correcting || busy || conflict) return;
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(correctAmount)) {
      setError("أدخل المبلغ المعاد فعليًا حتى منزلتين عشريتين؛ الصفر مسموح."); focus(`${prefix}-correct-amount`); return;
    }
    if (!correctionReason.trim()) { setError("أدخل سبب التصحيح."); focus(`${prefix}-correct-reason`); return; }
    if (correctionPreview) { setConfirmCorrection(true); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`students/${studentId}/refunds/${correcting.id}/corrections/preview`, "POST", {
        correct_amount: correctAmount, version: options.version,
      });
      if (!response.ok) {
        if (response.status === 409) setConflict(true);
        setError(response.status === 409 ? "تغير الرصيد أو سجل الاسترداد. حمّل أحدث البيانات." : await responseMessage(response));
        return;
      }
      setCorrectionPreview(await response.json() as CorrectionPreview);
      focus(`${prefix}-correction-preview`);
    } catch { setError("تعذرت معاينة التصحيح. تحقق من الاتصال وأعد المحاولة."); }
    finally { setBusy(false); }
  }

  async function commitCorrection() {
    if (!options || !correcting || !correctionPreview || submitting.current || conflict) return;
    submitting.current = true; setBusy(true); setError(""); setNotice("");
    let committed = false;
    try {
      requestId.current ??= newSubmissionId();
      const response = await centerRequest(`students/${studentId}/refunds/${correcting.id}/corrections`, "POST", {
        correct_amount: correctionPreview.correct_amount, reason: correctionReason.trim(),
        version: correctionPreview.version, request_id: requestId.current,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setUncertain(false); setCorrectionPreview(null); setError("تغير الرصيد أو الطلب. حمّل أحدث البيانات وراجع التصحيح."); }
        else if (response.status >= 500) { setUncertain(true); setError("تعذر التأكد من حفظ التصحيح. أعد المحاولة بالمفتاح نفسه."); }
        else { setUncertain(false); setError(await responseMessage(response)); }
        return;
      }
      committed = true; requestId.current = null; setUncertain(false);
      setCorrecting(null); setCorrectAmount(""); setCorrectionReason(""); setCorrectionPreview(null);
    } catch { setUncertain(true); setError("تعذر التأكد من حفظ التصحيح. أعد المحاولة بالمفتاح نفسه."); }
    finally { submitting.current = false; setBusy(false); }
    if (committed) {
      const refreshed = await Promise.allSettled([load(options.pagination.page), onChanged()]);
      setNotice(refreshed.some(result => result.status === "rejected" || result.value === null)
        ? "حُفظ التصحيح، لكن تعذر تحديث الحساب. حمّل أحدث البيانات." : "حُفظ عكس الاسترداد وبديله المرتبطان دون رد نقدي جديد.");
      focus(`${prefix}-title`);
    }
  }

  if (loading && !options) return <section className="context-card" aria-busy="true"><p>جارٍ تحميل سجل الاسترداد…</p></section>;
  return <section className="context-card form-stack" aria-labelledby={`${prefix}-title`}>
    <h2 id={`${prefix}-title`} data-payment-refund-title tabIndex={-1}>رد المال الفعلي — دفعة {payment.id.slice(0, 8)}</h2>
    {options ? <p>فرع الاستلام: {options.payment.branch_name}؛ المقبوض <bdi dir="ltr">{options.payment.received_amount}</bdi>، المخصص <bdi dir="ltr">{options.payment.allocated_amount}</bdi>، المعاد فعليًا <bdi dir="ltr">{options.payment.refunded_amount}</bdi>، المتاح <strong><bdi dir="ltr">{options.payment.available_before} {options.payment.currency}</bdi></strong>.</p> : null}
    <p className="muted">يمكن إبقاء الرصيد متاحًا لتسجيل لاحق. الاسترداد يسجل مالًا أُعيد فعليًا للطالب ولا يتبع الانسحاب أو تسوية الرسوم تلقائيًا.</p>
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {conflict ? <CenterHeaderActions><Button disabled={busy} onClick={() => { void reloadAfterConflict(); }}>تحميل أحدث الرصيد</Button></CenterHeaderActions> : null}
    {options?.can_refund && !correcting ? <section className="form-stack" aria-label="تسجيل رد نقدي">
      <h3>تسجيل مبلغ أُعيد فعليًا</h3>
      <form id={refundForm} noValidate onSubmit={previewRefund}><FieldSet disabled={busy || uncertain || conflict} className="border-0 p-0"><FieldGroup>
        <FormField id={`${prefix}-amount`} label={`المبلغ المعاد (${options.payment.currency})`} type="text" direction="ltr" value={amount}
          onChange={(value) => { setAmount(value); changeRefund(); }} />
        <FormField id={`${prefix}-date`} label="تاريخ الرد الفعلي" type="date" value={refundedOn}
          onChange={(value) => { setRefundedOn(value); changeRefund(); }} />
        <FormField id={`${prefix}-reason`} label="سبب الاسترداد" type="text" value={reason}
          onChange={(value) => { setReason(value); changeRefund(); }} />
      </FieldGroup></FieldSet></form>
      {refundPreview ? <section className="context-card form-stack" aria-labelledby={`${prefix}-refund-preview`}>
        <h4 id={`${prefix}-refund-preview`} tabIndex={-1}>معاينة الرد النقدي</h4>
        <p>ستُسجل حركة مستقلة بمبلغ <bdi dir="ltr">{refundPreview.amount} {options.payment.currency}</bdi> بتاريخ <bdi dir="ltr">{refundPreview.refunded_on}</bdi>، من دفعة {options.payment.branch_name}.</p>
        <p>الرصيد المتاح من الدفعة: <bdi dir="ltr">{refundPreview.payment.available_before}</bdi> ← <strong><bdi dir="ltr">{refundPreview.available_after} {options.payment.currency}</bdi></strong>.</p>
      </section> : null}
      <CenterHeaderActions>
        <Button id={`${prefix}-refund-submit`} form={refundForm} type="submit" variant="primary" busy={busy} disabled={conflict}>{refundPreview ? "اعتماد رد المبلغ" : "معاينة رد المبلغ"}</Button>
        <Button disabled={busy || uncertain || !dirty} onClick={() => { setAmount(""); setRefundedOn(""); setReason(""); setRefundPreview(null); requestId.current = null; setError(""); focus(`${prefix}-amount`); }}>إلغاء بيانات الرد</Button>
      </CenterHeaderActions>
    </section> : null}
    {options ? <DataTable id="student-payment-refunds" title="سجل الاسترداد والتصحيح" rows={options.history} rowKey={row => row.id} pageSize={20}
      searchText={row => `${row.amount} ${row.reason} ${row.refunded_on} ${row.actor_name}`}
      emptyMessage="لم يسجل رد نقدي من هذه الدفعة." description="الأصل والعكس والبديل محفوظون؛ يظهر المبلغ الفعلي الساري بعد التصحيح."
      columns={[
        { key: "date", label: "تاريخ الرد", render: row => <bdi dir="ltr">{row.refunded_on}</bdi> },
        { key: "amount", label: "المبلغ المسجل", render: row => <bdi dir="ltr">{row.amount} {row.currency}</bdi> },
        { key: "reason", label: "السبب", render: row => row.reason },
        { key: "actor", label: "الموظف", render: row => row.actor_name },
        { key: "status", label: "الحالة", render: row => row.reversal_id
          ? <>صُحح بواسطة {row.corrected_by_name}: {row.correction_reason}؛ البديل <bdi dir="ltr">{row.replacement_amount ?? "0.00"} {row.currency}</bdi></>
          : "سارٍ" },
        { key: "actions", label: "الإجراءات", actions: true, render: row => options.can_correct && !row.reversal_id
          ? <Button id={`${prefix}-correct-${row.id}`} disabled={busy || uncertain || dirty} onClick={() => {
            setCorrecting(row); setAmount(""); setRefundedOn(""); setReason(""); setRefundPreview(null);
            setCorrectAmount(""); setCorrectionReason(""); setCorrectionPreview(null); requestId.current = null;
            focus(`${prefix}-correct-amount`);
          }}>تصحيح المبلغ</Button> : null },
      ]} /> : null}
    {options && (options.pagination.page > 1 || options.pagination.has_more) ? <CenterHeaderActions>
      {options.pagination.page > 1 ? <Button disabled={dirty || busy || uncertain} onClick={() => { void load(options.pagination.page - 1); }}>حركات أحدث</Button> : null}
      {options.pagination.has_more ? <Button disabled={dirty || busy || uncertain} onClick={() => { void load(options.pagination.page + 1); }}>حركات أقدم</Button> : null}
    </CenterHeaderActions> : null}
    {correcting && options ? <section className="form-stack" aria-label="تصحيح مبلغ الاسترداد">
      <h3>تصحيح الاسترداد المسجل</h3>
      <p>الأصل: <bdi dir="ltr">{correcting.amount} {correcting.currency}</bdi> بتاريخ <bdi dir="ltr">{correcting.refunded_on}</bdi>. التصحيح عكس وبديل محاسبي مترابطان، ولا يعني إعادة نقدية ثانية.</p>
      <form id={correctionForm} noValidate onSubmit={previewCorrection}><FieldSet disabled={busy || uncertain || conflict} className="border-0 p-0"><FieldGroup>
        <FormField id={`${prefix}-correct-amount`} label={`المبلغ الذي أُعيد فعليًا (${options.payment.currency})`} type="text" direction="ltr" value={correctAmount}
          onChange={(value) => { setCorrectAmount(value); changeCorrection(); }} hint="أدخل 0.00 إذا لم يُرد أي مبلغ فعليًا." />
        <FormField id={`${prefix}-correct-reason`} label="سبب التصحيح" type="text" value={correctionReason}
          onChange={(value) => { setCorrectionReason(value); changeCorrection(); }} />
      </FieldGroup></FieldSet></form>
      {correctionPreview ? <section className="context-card form-stack" aria-labelledby={`${prefix}-correction-preview`}>
        <h4 id={`${prefix}-correction-preview`} tabIndex={-1}>معاينة تصحيح الاسترداد</h4>
        <p>المقبوض الأصلي: <bdi dir="ltr">{correctionPreview.payment.received_amount} {options.payment.currency}</bdi>؛ المخصص لاحقًا: <bdi dir="ltr">{correctionPreview.payment.allocated_amount}</bdi>؛ المعاد المسجل قبل التصحيح: <bdi dir="ltr">{correctionPreview.payment.refunded_amount}</bdi>.</p>
        <p>الاسترداد الأصلي <bdi dir="ltr">{correctionPreview.original.amount}</bdi> ← الصحيح <bdi dir="ltr">{correctionPreview.correct_amount}</bdi>. الرصيد المتاح: <bdi dir="ltr">{correctionPreview.payment.available_before}</bdi> ← <strong><bdi dir="ltr">{correctionPreview.available_after} {options.payment.currency}</bdi></strong>.</p>
        <p>الحركات المسجلة منذ وقت الأصل على هذه الدفعة: {correctionPreview.later_movements.length.toLocaleString("ar-EG")}.</p>
        {correctionPreview.later_movements.map(item => <p key={item.id}>{laterLabels[item.event] ?? "حركة مالية"} — <bdi dir="ltr">{item.created_at}</bdi></p>)}
      </section> : null}
      <CenterHeaderActions>
        <Button id={`${prefix}-correction-submit`} form={correctionForm} type="submit" variant="primary" busy={busy} disabled={conflict}>{correctionPreview ? "اعتماد التصحيح" : "معاينة التصحيح"}</Button>
        <Button disabled={busy || uncertain} onClick={() => { const trigger = correcting.id; setCorrecting(null); setCorrectAmount(""); setCorrectionReason(""); setCorrectionPreview(null); requestId.current = null; setError(""); focus(`${prefix}-correct-${trigger}`); }}>إلغاء التصحيح</Button>
      </CenterHeaderActions>
    </section> : null}
    {confirmRefund && refundPreview ? <ConfirmationDialog title="تأكيد رد مبلغ فعلي"
      description={`سيسجل رد ${refundPreview.amount} ${options?.payment.currency ?? ""} فعليًا من دفعة ${options?.payment.branch_name ?? ""} بتاريخ ${refundPreview.refunded_on}.`}
      confirmLabel="تأكيد الاسترداد" onCancel={() => { setConfirmRefund(false); focus(`${prefix}-refund-submit`); }}
      onConfirm={() => { setConfirmRefund(false); void commitRefund(); }} /> : null}
    {confirmCorrection && correctionPreview ? <ConfirmationDialog title="تأكيد تصحيح الاسترداد"
      description={`سيُعكس السجل ${correctionPreview.original.amount} ${options?.payment.currency ?? ""} ويُسجل الصحيح ${correctionPreview.correct_amount}، دون حركة نقدية ثانية.`}
      confirmLabel="تأكيد التصحيح" onCancel={() => { setConfirmCorrection(false); focus(`${prefix}-correction-submit`); }}
      onConfirm={() => { setConfirmCorrection(false); void commitCorrection(); }} /> : null}
    <CenterHeaderActions><Button disabled={busy || uncertain || dirty} onClick={onClose}>إغلاق سجل الاسترداد</Button></CenterHeaderActions>
  </section>;
}
