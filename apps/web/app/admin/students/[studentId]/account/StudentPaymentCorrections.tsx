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

type Allocation = { id: string; fee_id: string; attempt_id: string; target_branch_id: number;
  target_branch_name: string; amount: string; fee_due: string; fee_paid: string };
type Balance = { id: string; branch_id: number; branch_name: string; currency: string;
  received_before: string; allocated_before: string; refunded_amount: string; available_before: string };
type Options = { payment: Balance; original_amount: string; version: string; can_correct: boolean;
  allocations: Allocation[]; history: { id: string; amount: string; reason: string; actor_name: string; created_at: string }[];
  pagination: { page: number; has_more: boolean; history_page: number; history_has_more: boolean } };
type Preview = { version: string; payment: Balance & { received_after: string; allocated_after: string; available_after: string };
  allocations: { id: string; fee_id: string; target_branch_id: number; amount_before: string; amount_after: string;
    fee_debt_before: string; fee_debt_after: string }[];
  account: { branch_ids: number[]; before: { available: string; debt: string }; after: { available: string; debt: string } } };

export function StudentPaymentCorrections({ studentId, payment, onClose, onChanged, onDirtyChange, onUncertainChange }: {
  studentId: string; payment: StudentPayment; onClose: () => void; onChanged: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void; onUncertainChange: (uncertain: boolean) => void;
}) {
  const prefix = useId();
  const [options, setOptions] = useState<Options | null>(null);
  const [correctAmount, setCorrectAmount] = useState("");
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  const path = `students/${studentId}/payments/${payment.id}/corrections`;
  const dirty = Boolean(correctAmount || reason || Object.keys(changes).length);

  const load = useCallback(async (page = 1, historyPage = 1): Promise<Options | null> => {
    setLoading(true);
    try {
      const response = await centerRequest(`${path}?page=${page}&history_page=${historyPage}`, "GET");
      if (!response.ok) { setError(await responseMessage(response)); return null; }
      const next = await response.json() as Options;
      setOptions(next); setConflict(false);
      return next;
    } catch { setError("تعذر تحميل تفاصيل الدفعة. تحقق من الاتصال."); return null; }
    finally { setLoading(false); }
  }, [path]);

  useEffect(() => { const timeout = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timeout); }, [load]);
  useEffect(() => { onDirtyChange(dirty || uncertain); return () => onDirtyChange(false); }, [dirty, uncertain, onDirtyChange]);
  useEffect(() => { onUncertainChange(uncertain); return () => onUncertainChange(false); }, [uncertain, onUncertainChange]);
  function focus(id: string) { requestAnimationFrame(() => document.getElementById(id)?.focus()); }
  function invalidate() { setPreview(null); setError(""); requestId.current = null; }
  function changedAllocations() {
    return Object.entries(changes).map(([id, amount]) => ({ id, amount }));
  }
  function discard() {
    setCorrectAmount(""); setReason(""); setChanges({}); setPreview(null);
    setError(""); requestId.current = null; focus(`${prefix}-amount`);
  }
  async function refresh() {
    const next = await load(options?.pagination.page, options?.pagination.history_page);
    if (next) { setPreview(null); requestId.current = null; setError(""); }
  }

  async function previewCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!options || busy || conflict || uncertain) return;
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(correctAmount)) {
      setError("أدخل المقبوض الصحيح حتى منزلتين عشريتين؛ الصفر مسموح."); focus(`${prefix}-amount`); return;
    }
    for (const [id, amount] of Object.entries(changes)) {
      if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(amount)) {
        setError("راجع مبلغ التخصيص الصحيح."); focus(`${prefix}-allocation-${id}`); return;
      }
    }
    if (!reason.trim()) { setError("أدخل سبب التصحيح."); focus(`${prefix}-reason`); return; }
    if (preview) { setConfirm(true); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`${path}/preview`, "POST", {
        correct_amount: correctAmount, allocations: changedAllocations(), version: options.version,
      });
      if (!response.ok) {
        if (response.status === 409) setConflict(true);
        setError(response.status === 409 ? "تغير الحساب أو أصبحت التخصيصات غير صالحة. حمّل أحدث البيانات." : await responseMessage(response));
        return;
      }
      setPreview(await response.json() as Preview); focus(`${prefix}-preview`);
    } catch { setError("تعذرت معاينة التصحيح. تحقق من الاتصال."); }
    finally { setBusy(false); }
  }

  async function commit() {
    if (!preview || submitting.current || conflict) return;
    submitting.current = true; setBusy(true); setError(""); setNotice("");
    let committed = false;
    try {
      requestId.current ??= newSubmissionId();
      const response = await centerRequest(path, "POST", {
        correct_amount: preview.payment.received_after,
        allocations: preview.allocations.map(row => ({ id: row.id, amount: row.amount_after })),
        reason: reason.trim(), version: preview.version, request_id: requestId.current,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setUncertain(false); setPreview(null); setError("تغير الحساب أو الطلب. حمّل أحدث البيانات وراجع التصحيح."); }
        else if (response.status >= 500) { setUncertain(true); setError("نتيجة التصحيح غير مؤكدة. تحقق بإعادة الطلب بالمفتاح نفسه."); }
        else { setUncertain(false); setError(await responseMessage(response)); }
        return;
      }
      committed = true; requestId.current = null; setUncertain(false);
      setCorrectAmount(""); setReason(""); setChanges({}); setPreview(null);
    } catch { setUncertain(true); setError("نتيجة التصحيح غير مؤكدة. تحقق بإعادة الطلب بالمفتاح نفسه."); }
    finally { submitting.current = false; setBusy(false); }
    if (committed) {
      const results = await Promise.allSettled([load(1), onChanged()]);
      setNotice(results.some(item => item.status === "rejected" || item.value === null)
        ? "حُفظ التصحيح، لكن تعذر تحديث الحساب. حمّل أحدث البيانات." : "حُفظ عكس الدفعة وبديلها مع التخصيصات المرتبطة.");
      focus(`${prefix}-title`);
    }
  }

  if (loading && !options) return <section className="context-card" aria-busy="true"><p>جارٍ تحميل تصحيح الدفعة…</p></section>;
  return <section className="context-card form-stack" aria-labelledby={`${prefix}-title`}>
    <h2 id={`${prefix}-title`} data-payment-correction-title tabIndex={-1}>تصحيح الدفعة وتخصيصاتها — {payment.id.slice(0, 8)}</h2>
    {options ? <p>فرع الاستلام: {options.payment.branch_name}. الإيصال الأصلي <bdi dir="ltr">{options.original_amount}</bdi>، المقبوض الساري <bdi dir="ltr">{options.payment.received_before}</bdi>، المخصص <bdi dir="ltr">{options.payment.allocated_before}</bdi>، المعاد فعليًا <bdi dir="ltr">{options.payment.refunded_amount}</bdi>، المتاح <bdi dir="ltr">{options.payment.available_before} {options.payment.currency}</bdi>.</p> : null}
    <p className="muted">يُحفظ الأصل. التصحيح يسجل عكسًا وبديلًا للمقبوض وكل تخصيص متغير في إجراء واحد، ولا يسجل استردادًا نقديًا.</p>
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {conflict ? <CenterHeaderActions><Button disabled={busy} onClick={() => { void refresh(); }}>تحميل أحدث الحساب</Button></CenterHeaderActions> : null}
    {options?.can_correct ? <>
      <form id={`${prefix}-form`} noValidate onSubmit={previewCorrection}><FieldSet disabled={busy || uncertain || conflict} className="border-0 p-0"><FieldGroup>
        <FormField id={`${prefix}-amount`} label={`المقبوض الصحيح (${options.payment.currency})`} type="text" direction="ltr" value={correctAmount}
          onChange={value => { setCorrectAmount(value); invalidate(); }} hint="إذا صار المقبوض أقل من المخصص والمعاد، خفّض التخصيصات أدناه." />
        <FormField id={`${prefix}-reason`} label="سبب التصحيح" type="text" value={reason}
          onChange={value => { setReason(value); invalidate(); }} />
      </FieldGroup></FieldSet></form>
      <DataTable id="payment-correction-allocations" title="التخصيصات السارية" rows={options.allocations} rowKey={row => row.id} pageSize={20}
        searchText={row => `${row.target_branch_name} ${row.amount} ${row.fee_id}`}
        emptyMessage="لا توجد تخصيصات سارية لهذه الدفعة." description="عدّل التخصيصات التي يلزم تغييرها فقط؛ تُحفظ القيم الأخرى كما هي."
        columns={[
          { key: "branch", label: "فرع الرسوم", render: row => row.target_branch_name },
          { key: "original", label: "المخصص الحالي", render: row => <bdi dir="ltr">{row.amount} {options.payment.currency}</bdi> },
          { key: "fee", label: "المستحق والمسدد", render: row => <bdi dir="ltr">{row.fee_due} / {row.fee_paid} {options.payment.currency}</bdi> },
          { key: "correct", label: "المخصص الصحيح", render: row => <FormField id={`${prefix}-allocation-${row.id}`}
            label={`المخصص الصحيح لرسوم ${row.target_branch_name}، تخصيص ${row.id.slice(0, 8)}`} type="text" direction="ltr"
            value={changes[row.id] ?? row.amount} disabled={busy || uncertain || conflict}
            onChange={value => { setChanges(current => {
              const next = { ...current };
              if (value === row.amount) delete next[row.id]; else next[row.id] = value;
              return next;
            }); invalidate(); }} /> },
        ]} />
      {options.pagination.page > 1 || options.pagination.has_more ? <CenterHeaderActions>
        {options.pagination.page > 1 ? <Button disabled={busy || uncertain || conflict} onClick={() => { void load(options.pagination.page - 1, options.pagination.history_page); }}>تخصيصات سابقة</Button> : null}
        {options.pagination.has_more ? <Button disabled={busy || uncertain || conflict} onClick={() => { void load(options.pagination.page + 1, options.pagination.history_page); }}>تخصيصات تالية</Button> : null}
      </CenterHeaderActions> : null}
      {preview ? <section className="context-card form-stack" aria-labelledby={`${prefix}-preview`}>
        <h3 id={`${prefix}-preview`} tabIndex={-1}>معاينة التصحيح</h3>
        <p>المقبوض: <bdi dir="ltr">{preview.payment.received_before}</bdi> ← <bdi dir="ltr">{preview.payment.received_after}</bdi>؛ المخصص: <bdi dir="ltr">{preview.payment.allocated_before}</bdi> ← <bdi dir="ltr">{preview.payment.allocated_after}</bdi>.</p>
        <p>المعاد فعليًا: <bdi dir="ltr">{preview.payment.refunded_amount}</bdi>؛ المتاح: <bdi dir="ltr">{preview.payment.available_before}</bdi> ← <bdi dir="ltr">{preview.payment.available_after} {preview.payment.currency}</bdi>.</p>
        <p>دين الفروع المعنية: <bdi dir="ltr">{preview.account.before.debt}</bdi> ← <bdi dir="ltr">{preview.account.after.debt}</bdi>؛ رصيدها المتاح: <bdi dir="ltr">{preview.account.before.available}</bdi> ← <bdi dir="ltr">{preview.account.after.available}</bdi>.</p>
        {preview.allocations.map(row => <p key={row.id}>تخصيص رسوم <bdi dir="ltr">{row.fee_id}</bdi>: <bdi dir="ltr">{row.amount_before}</bdi> ← <bdi dir="ltr">{row.amount_after}</bdi>؛ الدين <bdi dir="ltr">{row.fee_debt_before}</bdi> ← <bdi dir="ltr">{row.fee_debt_after}</bdi>.</p>)}
      </section> : null}
      <CenterHeaderActions>
        {uncertain ? <Button variant="primary" busy={busy} onClick={() => { void commit(); }}>التحقق من نتيجة التصحيح</Button>
          : <Button id={`${prefix}-submit`} form={`${prefix}-form`} type="submit" variant="primary" busy={busy} disabled={conflict}>{preview ? "اعتماد التصحيح" : "معاينة التصحيح"}</Button>}
        <Button disabled={busy || uncertain || !dirty} onClick={discard}>إلغاء بيانات التصحيح</Button>
      </CenterHeaderActions>
    </> : null}
    {options ? <DataTable id="payment-correction-history" title="سجل التصحيحات" rows={options.history} rowKey={row => row.id} pageSize={20}
      searchText={row => `${row.amount} ${row.reason} ${row.actor_name}`}
      emptyMessage="لم يُصحح المقبوض بعد." description="كل تصحيح يحفظ حركة عكس وبديل مستقلتين."
      columns={[
        { key: "amount", label: "المقبوض البديل", render: row => <bdi dir="ltr">{row.amount} {options.payment.currency}</bdi> },
        { key: "reason", label: "السبب", render: row => row.reason },
        { key: "actor", label: "الموظف", render: row => row.actor_name },
        { key: "date", label: "التاريخ", render: row => <bdi dir="ltr">{row.created_at}</bdi> },
      ]} /> : null}
    {options && (options.pagination.history_page > 1 || options.pagination.history_has_more) ? <CenterHeaderActions>
      {options.pagination.history_page > 1 ? <Button disabled={busy || uncertain || conflict} onClick={() => { void load(options.pagination.page, options.pagination.history_page - 1); }}>تصحيحات أحدث</Button> : null}
      {options.pagination.history_has_more ? <Button disabled={busy || uncertain || conflict} onClick={() => { void load(options.pagination.page, options.pagination.history_page + 1); }}>تصحيحات أقدم</Button> : null}
    </CenterHeaderActions> : null}
    {confirm && preview ? <ConfirmationDialog title="تأكيد تصحيح الدفعة وتخصيصاتها"
      description={`سيصبح المقبوض ${preview.payment.received_after} ${preview.payment.currency} والمخصص ${preview.payment.allocated_after}. ستُحفظ الحركات الأصلية والعكس والبدائل دون استرداد نقدي.`}
      confirmLabel="تأكيد التصحيح" onCancel={() => { setConfirm(false); focus(`${prefix}-submit`); }}
      onConfirm={() => { setConfirm(false); void commit(); }} /> : null}
    <CenterHeaderActions><Button disabled={busy || uncertain || dirty} onClick={onClose}>إغلاق التصحيح</Button></CenterHeaderActions>
  </section>;
}
