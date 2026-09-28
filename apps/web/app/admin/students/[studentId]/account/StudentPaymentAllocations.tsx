"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { DataTable } from "@/components/DataTable";
import { FormField } from "@/components/FormField";
import { FieldGroup, FieldSet } from "@/components/ui/field";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";
import type { StudentPayment } from "@/lib/server-context";
import { FinancialEventNoteEditor } from "./FinancialEventNoteEditor";

type Fee = { id: string; attempt_id: string; group_name: string | null; fee_created_at: string; net_amount: string; paid_amount: string; remaining_amount: string; currency: string };
type Allocation = { id: string; fee_id: string; attempt_id: string; group_name: string | null; fee_created_at: string; amount: string; currency: string; actor_name: string; created_at: string; reversal_id: string | null; reversal_reason: string | null; reversed_by_name: string | null; reversed_at: string | null };
type Options = { payment: { id: string; available_amount: string; amount: string; currency: string }; version: string; can_allocate: boolean; can_correct: boolean; fees: Fee[]; history: Allocation[]; pagination: { page: number; has_more: boolean; history_page: number; history_has_more: boolean } };

function cents(value: string): number {
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export function StudentPaymentAllocations({ studentId, payment, onClose, onChanged, onDirtyChange }: {
  studentId: string; payment: StudentPayment; onClose: () => void; onChanged: () => Promise<void>; onDirtyChange: (dirty: boolean) => void;
}) {
  const prefix = useId();
  const formId = `${prefix}-allocation-form`;
  const reversalFormId = `${prefix}-reversal-form`;
  const [options, setOptions] = useState<Options | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [selectedFees, setSelectedFees] = useState<Record<string, Fee>>({});
  const [reversing, setReversing] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<{ type: "payment" | "allocation"; id: string; label: string } | null>(null);
  const [noteDirty, setNoteDirty] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uncertain, setUncertain] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  const dirty = Object.values(amounts).some(Boolean) || Boolean(reason) || noteDirty;
  const path = `students/${studentId}/payments/${payment.id}`;

  const load = useCallback(async (page = 1, historyPage = 1) => {
    setLoading(true); setError("");
    try {
      const response = await centerRequest(`${path}/allocation-options?${new URLSearchParams({ page: String(page), history_page: String(historyPage) })}`, "GET");
      if (!response.ok) { setError(await responseMessage(response)); return; }
      setOptions(await response.json() as Options); setConflict(false);
    } catch { setError("تعذر تحميل التخصيصات. تحقق من الاتصال وأعد المحاولة."); }
    finally { setLoading(false); }
  }, [path]);

  useEffect(() => { const timeout = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timeout); }, [load]);
  useEffect(() => { onDirtyChange(dirty || uncertain); return () => onDirtyChange(false); }, [dirty, uncertain, onDirtyChange]);

  function focus(id: string) { requestAnimationFrame(() => document.getElementById(id)?.focus()); }

  async function allocate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!options || submitting.current || conflict) return;
    const chosen = Object.values(selectedFees).filter((fee) => amounts[fee.attempt_id]?.trim());
    if (!chosen.length) { setError("حدد مبلغ تخصيص لمحاولة واحدة على الأقل."); focus(`${prefix}-${options.fees[0]?.attempt_id}`); return; }
    if (chosen.length > 20) { setError("يمكن اعتماد ٢٠ محاولة في عملية واحدة. احفظ الدفعة الحالية ثم أكمل الباقي."); focus(`${prefix}-title`); return; }
    for (const fee of chosen) {
      const amount = amounts[fee.attempt_id].trim();
      if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(amount) || cents(amount) <= 0 || cents(amount) > cents(fee.remaining_amount)) {
        setError(`راجع مبلغ تخصيص ${fee.group_name ?? fee.attempt_id}؛ الحد المتبقي ${fee.remaining_amount} ${fee.currency}.`);
        focus(options.fees.some((item) => item.attempt_id === fee.attempt_id) ? `${prefix}-${fee.attempt_id}` : `${prefix}-title`); return;
      }
    }
    if (chosen.reduce((sum, fee) => sum + cents(amounts[fee.attempt_id].trim()), 0) > cents(options.payment.available_amount)) {
      setError(`إجمالي التخصيص أكبر من رصيد الدفعة المتاح ${options.payment.available_amount} ${options.payment.currency}.`);
      focus(`${prefix}-${chosen[0].attempt_id}`); return;
    }
    submitting.current = true; setBusy(true); setError(""); setNotice("");
    try {
      requestId.current ??= newSubmissionId();
      const response = await centerRequest(`${path}/allocations`, "POST", {
        targets: chosen.map((fee) => ({ attempt_id: fee.attempt_id, amount: amounts[fee.attempt_id].trim() })),
        version: options.version, request_id: requestId.current,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setUncertain(false); setError("تغير الحساب أو الرصيد. حمّل أحدث البيانات وراجع المبالغ."); }
        else { setUncertain(false); setError(await responseMessage(response)); }
        return;
      }
      requestId.current = null; setUncertain(false); setAmounts({}); setSelectedFees({});
      setNotice("حُفظ التخصيص. يمكن تصحيح خطأ بتسجيل عكس مستقل مع سبب، ثم تخصيص جديد.");
      await Promise.all([load(), onChanged()]);
      focus(`${prefix}-title`);
    } catch { setUncertain(true); setError("تعذر التأكد من حفظ التخصيص. أبقِ المبالغ وأعد المحاولة بالمفتاح نفسه."); }
    finally { submitting.current = false; setBusy(false); }
  }

  async function reverse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!options || !reversing || submitting.current || conflict) return;
    if (!reason.trim()) { setError("أدخل سبب عكس التخصيص."); focus(`${prefix}-reason`); return; }
    submitting.current = true; setBusy(true); setError(""); setNotice("");
    try {
      requestId.current ??= newSubmissionId();
      const response = await centerRequest(`students/${studentId}/allocations/${reversing}/reverse`, "POST", {
        reason: reason.trim(), version: options.version, request_id: requestId.current,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setUncertain(false); setError("تغير التخصيص أو الحساب. حمّل أحدث البيانات قبل التصحيح."); }
        else { setUncertain(false); setError(await responseMessage(response)); }
        return;
      }
      setReason(""); setReversing(null); requestId.current = null; setUncertain(false);
      setNotice("سُجل عكس التخصيص مع سببه. الرصيد متاح الآن لتخصيص جديد.");
      await Promise.all([load(options.pagination.page, options.pagination.history_page), onChanged()]);
      focus(`${prefix}-title`);
    } catch { setUncertain(true); setError("تعذر التأكد من حفظ العكس. أبقِ السبب وأعد المحاولة بالمفتاح نفسه."); }
    finally { submitting.current = false; setBusy(false); }
  }

  const changePage = (page: number, historyPage: number) => {
    if (uncertain || busy) return;
    void load(page, historyPage);
  };

  return <section className="context-card form-stack" aria-labelledby={`${prefix}-title`}>
    <h2 id={`${prefix}-title`} data-payment-allocation-title tabIndex={-1}>تخصيص الدفعة المستلمة في <bdi dir="ltr">{payment.received_on}</bdi></h2>
    <p>المبلغ: <bdi dir="ltr">{payment.amount} {payment.currency}</bdi> — المتاح حاليًا: <strong><bdi dir="ltr">{options?.payment.available_amount ?? payment.available_amount} {payment.currency}</bdi></strong></p>
    <p className="muted">اختر المحاولات والمبالغ صراحةً. التخصيص لا يغيّر الدفعة أو الرسوم الأصلية، والتصحيح يُسجل كحركة عكس مستقلة.</p>
    <CenterHeaderActions><Button id={`${prefix}-payment-note`} disabled={busy || dirty} onClick={() => setSelectedNote({ type: "payment", id: payment.id, label: "الدفعة" })}>ملاحظة الدفعة وتاريخها</Button></CenterHeaderActions>
    {selectedNote?.type === "payment" ? <FinancialEventNoteEditor studentId={studentId} type="payment" eventId={payment.id} label="الدفعة"
      onDirtyChange={setNoteDirty} onClose={() => { setSelectedNote(null); focus(`${prefix}-payment-note`); }} /> : null}
    {loading ? <p role="status">جارٍ تحميل الرسوم والحركات…</p> : null}
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {conflict ? <CenterHeaderActions><Button disabled={busy || uncertain} onClick={() => { requestId.current = null; void load(options?.pagination.page, options?.pagination.history_page); }}>تحميل أحدث الرصيد</Button></CenterHeaderActions> : null}
    {options?.can_allocate ? <>
      <form id={formId} noValidate onSubmit={allocate} className="form-stack">
        <h3>رسوم المحاولات في فرع الدفعة</h3>
        {Object.values(selectedFees).some((fee) => amounts[fee.attempt_id]?.trim()) ? <p>المحاولات المحددة عبر الصفحات: {Object.values(selectedFees).filter((fee) => amounts[fee.attempt_id]?.trim()).length} — إجمالي المبالغ: <bdi dir="ltr">{(Object.values(selectedFees).reduce((sum, fee) => sum + (/^\d{1,10}(?:\.\d{1,2})?$/.test(amounts[fee.attempt_id] ?? "") ? cents(amounts[fee.attempt_id]) : 0), 0) / 100).toFixed(2)} {options.payment.currency}</bdi></p> : null}
        <FieldSet disabled={busy || uncertain || conflict} className="border-0 p-0"><FieldGroup>
          {options.fees.length ? options.fees.map((fee) => <FormField key={fee.id} id={`${prefix}-${fee.attempt_id}`}
            label={`${fee.group_name ?? "مجموعة غير متاحة"} — محاولة ${fee.attempt_id.slice(0, 8)} بتاريخ ${fee.fee_created_at.slice(0, 10)} — المستحق ${fee.net_amount}، المسدد ${fee.paid_amount}، المتبقي ${fee.remaining_amount} ${fee.currency}`}
            type="text" direction="ltr" value={amounts[fee.attempt_id] ?? ""}
            onChange={(value) => { setAmounts((items) => ({ ...items, [fee.attempt_id]: value })); setSelectedFees((items) => value.trim() ? { ...items, [fee.attempt_id]: fee } : Object.fromEntries(Object.entries(items).filter(([id]) => id !== fee.attempt_id))); setError(""); requestId.current = null; }}
            disabled={cents(fee.remaining_amount) === 0}
            hint={`معرّف المحاولة ${fee.attempt_id}. أدخل المبلغ أو اتركه فارغًا.`} />) : <p className="muted">لا توجد رسوم في هذا الفرع.</p>}
        </FieldGroup></FieldSet>
      </form>
      <CenterHeaderActions>
        <Button form={formId} type="submit" variant="primary" busy={busy} disabled={conflict || !Object.values(selectedFees).length || cents(options.payment.available_amount) === 0}>{uncertain ? "التحقق من التخصيص" : "تخصيص المبالغ المحددة"}</Button>
        <Button disabled={busy || uncertain || !Object.values(amounts).some(Boolean)} onClick={() => { setAmounts({}); setSelectedFees({}); requestId.current = null; setError(""); focus(options.fees[0] ? `${prefix}-${options.fees[0].attempt_id}` : `${prefix}-title`); }}>إلغاء المبالغ</Button>
      </CenterHeaderActions>
      {options.pagination.page > 1 || options.pagination.has_more ? <CenterHeaderActions>
        {options.pagination.page > 1 ? <Button disabled={busy || uncertain} onClick={() => changePage(options.pagination.page - 1, options.pagination.history_page)}>رسوم سابقة</Button> : null}
        {options.pagination.has_more ? <Button disabled={busy || uncertain} onClick={() => changePage(options.pagination.page + 1, options.pagination.history_page)}>رسوم تالية</Button> : null}
      </CenterHeaderActions> : null}
    </> : <p className="muted">لديك صلاحية عرض الحركات دون تخصيص مبالغ.</p>}
    <DataTable id={`${prefix}-history`} title="سجل التخصيص والعكس" rows={options?.history ?? []} rowKey={(row) => row.id} pageSize={20}
      searchText={(row) => `${row.group_name ?? ""} ${row.attempt_id} ${row.amount} ${row.actor_name} ${row.reversal_reason ?? ""}`}
      emptyMessage="لم تُسجل تخصيصات لهذه الدفعة." columns={[
        { key: "group", label: "المحاولة", render: (row) => <>{row.group_name ?? "مجموعة غير متاحة"} — <bdi dir="ltr" title={row.attempt_id}>{row.attempt_id.slice(0, 8)}</bdi></> },
        { key: "amount", label: "المبلغ", render: (row) => <bdi dir="ltr">{row.amount} {row.currency}</bdi> },
        { key: "status", label: "الحالة", render: (row) => row.reversal_id ? `معكوس: ${row.reversal_reason}` : "معتمد" },
        { key: "actor", label: "الموظف", render: (row) => row.actor_name },
        { key: "action", label: "إجراءات", actions: true, render: (row) => <span className="flex flex-wrap gap-2">
          <Button id={`${prefix}-allocation-note-${row.id}`} disabled={busy || uncertain || dirty} onClick={() => setSelectedNote({ type: "allocation", id: row.id, label: "التخصيص" })}>ملاحظة التخصيص</Button>
          {options?.can_correct && !row.reversal_id ? <Button id={`${prefix}-reverse-${row.id}`} disabled={busy || uncertain || dirty} onClick={() => { setReversing(row.id); setReason(""); requestId.current = null; focus(`${prefix}-reason`); }}>عكس التخصيص</Button> : null}
        </span> },
      ]} />
    {selectedNote?.type === "allocation" ? <FinancialEventNoteEditor key={selectedNote.id} studentId={studentId} type="allocation" eventId={selectedNote.id} label="التخصيص"
      onDirtyChange={setNoteDirty} onClose={() => { const trigger = selectedNote.id; setSelectedNote(null); focus(`${prefix}-allocation-note-${trigger}`); }} /> : null}
    {options && (options.pagination.history_page > 1 || options.pagination.history_has_more) ? <CenterHeaderActions>
      {options.pagination.history_page > 1 ? <Button disabled={dirty || busy || uncertain} onClick={() => changePage(options.pagination.page, options.pagination.history_page - 1)}>حركات سابقة</Button> : null}
      {options.pagination.history_has_more ? <Button disabled={dirty || busy || uncertain} onClick={() => changePage(options.pagination.page, options.pagination.history_page + 1)}>حركات تالية</Button> : null}
    </CenterHeaderActions> : null}
    {reversing ? <section className="form-stack" aria-label="عكس التخصيص">
      <h3>عكس التخصيص</h3>
      <form id={reversalFormId} noValidate onSubmit={reverse}><FieldSet disabled={busy || uncertain || conflict} className="border-0 p-0"><FieldGroup><FormField id={`${prefix}-reason`} label="سبب العكس" type="text" value={reason} onChange={(value) => { setReason(value); setError(""); requestId.current = null; }} hint="سيبقى التخصيص الأصلي ظاهرًا في السجل مع سبب العكس." /></FieldGroup></FieldSet></form>
      <CenterHeaderActions><Button form={reversalFormId} type="submit" variant="primary" busy={busy} disabled={conflict}>{uncertain ? "التحقق من العكس" : "اعتماد العكس"}</Button><Button disabled={busy || uncertain} onClick={() => { const trigger = reversing; setReversing(null); setReason(""); requestId.current = null; focus(`${prefix}-reverse-${trigger}`); }}>إلغاء التصحيح</Button></CenterHeaderActions>
    </section> : null}
    <CenterHeaderActions><Button disabled={busy || uncertain || dirty} onClick={onClose}>إغلاق تفاصيل الدفعة</Button></CenterHeaderActions>
  </section>;
}
