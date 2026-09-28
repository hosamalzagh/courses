"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { ChoiceField } from "@/components/ChoiceField";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { DataTable } from "@/components/DataTable";
import { FormField } from "@/components/FormField";
import { FieldGroup, FieldSet } from "@/components/ui/field";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";
import type { StudentPayment } from "@/lib/server-context";
import { FinancialEventNoteEditor } from "./FinancialEventNoteEditor";

type Fee = { id: string; attempt_id: string; branch_id: number; branch_name: string; group_name: string | null; fee_created_at: string; net_amount: string; current_due: string; paid_amount: string; remaining_amount: string; currency: string };
type Allocation = { id: string; fee_id: string; attempt_id: string; target_branch_id: number; target_branch_name: string; group_name: string | null; fee_created_at: string; amount: string; currency: string; actor_name: string; created_at: string; can_correct: boolean; reversal_id: string | null; reversal_reason: string | null; reversal_kind: string | null; corrected_allocation_id: string | null; reversed_by_name: string | null; reversed_at: string | null };
type Options = { payment: { id: string; branch_id: number; branch_name: string; available_amount: string; amount: string; currency: string }; version: string; can_allocate: boolean; can_correct: boolean; fees: Fee[]; history: Allocation[]; pagination: { page: number; has_more: boolean; history_page: number; history_has_more: boolean } };
type AllocationPreview = { version: string; cross_branch: boolean; source: { payment_id: string; branch_id: number; branch_name: string; currency: string; available_before: string; available_after: string };
  targets: { attempt_id: string; fee_id: string; branch_id: number; branch_name: string; group_name: string | null;
    amount: string; remaining_before: string; remaining_after: string }[] };
type CorrectionPreview = { version: string; source: { payment_id: string; branch_id: number; branch_name: string; received_amount: string; received_on: string; currency: string; available_before: string; available_after: string };
  original: { allocation_id: string; attempt_id: string; branch_id: number; branch_name: string; group_name: string | null; amount: string; remaining_before: string; remaining_after: string };
  target: { attempt_id: string; branch_id: number; branch_name: string; group_name: string | null; amount: string; remaining_before: string; remaining_after: string } | null;
  account: { available_before: string; available_after: string; debt_before: string; debt_after: string } };

function cents(value: string): number {
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export function StudentPaymentAllocations({ studentId, payment, focusNote, onClose, onChanged, onDirtyChange }: {
  studentId: string; payment: StudentPayment; focusNote?: string; onClose: () => void; onChanged: () => Promise<void>; onDirtyChange: (dirty: boolean) => void;
}) {
  const prefix = useId();
  const formId = `${prefix}-allocation-form`;
  const reversalFormId = `${prefix}-reversal-form`;
  const correctionFormId = `${prefix}-correction-form`;
  const [options, setOptions] = useState<Options | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [selectedFees, setSelectedFees] = useState<Record<string, Fee>>({});
  const [preview, setPreview] = useState<AllocationPreview | null>(null);
  const [confirmCrossBranch, setConfirmCrossBranch] = useState(false);
  const [reversing, setReversing] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<Allocation | null>(null);
  const [correctionTarget, setCorrectionTarget] = useState<Fee | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionPreview, setCorrectionPreview] = useState<CorrectionPreview | null>(null);
  const [confirmCorrection, setConfirmCorrection] = useState(false);
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
  const dirty = Object.values(amounts).some(Boolean) || Boolean(reason) || Boolean(correctionReason) || Boolean(correctionTarget) || noteDirty;
  const path = `students/${studentId}/payments/${payment.id}`;

  const load = useCallback(async (page = 1, historyPage = 1) => {
    setLoading(true); setError("");
    try {
      const response = await centerRequest(`${path}/allocation-options?${new URLSearchParams({ page: String(page), history_page: String(historyPage),
        ...(focusNote && focusNote !== "payment" ? { allocation_id: focusNote } : {}) })}`, "GET");
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const result = await response.json() as Options;
      setOptions(result); setConflict(false); setPreview(null); setCorrectionPreview(null);
      if (focusNote === "payment") setSelectedNote({ type: "payment", id: payment.id, label: "الدفعة" });
      else if (focusNote && result.history.some(row => row.id === focusNote)) setSelectedNote({ type: "allocation", id: focusNote, label: "التخصيص" });
    } catch { setError("تعذر تحميل التخصيصات. تحقق من الاتصال وأعد المحاولة."); }
    finally { setLoading(false); }
  }, [path, payment.id, focusNote]);

  useEffect(() => { const timeout = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timeout); }, [load]);
  useEffect(() => { onDirtyChange(dirty || uncertain); return () => onDirtyChange(false); }, [dirty, uncertain, onDirtyChange]);

  function focus(id: string) { requestAnimationFrame(() => document.getElementById(id)?.focus()); }

  async function commitAllocation(targets: { attempt_id: string; amount: string }[]) {
    if (!options || submitting.current || conflict) return;
    submitting.current = true; setBusy(true); setError(""); setNotice("");
    let committed = false;
    try {
      requestId.current ??= newSubmissionId();
      const response = await centerRequest(`${path}/allocations`, "POST", {
        targets,
        version: options.version, request_id: requestId.current,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setPreview(null); setUncertain(false); setError("تغير الحساب أو الرصيد. حمّل أحدث البيانات وراجع المبالغ."); }
        else if (response.status >= 500) { setUncertain(true); setError("تعذر التأكد من حفظ التخصيص. أبقِ المبالغ وأعد المحاولة بالمفتاح نفسه."); }
        else { setUncertain(false); setError(await responseMessage(response)); }
        return;
      }
      requestId.current = null; setUncertain(false); setPreview(null); setAmounts({}); setSelectedFees({});
      committed = true;
    } catch { setUncertain(true); setError("تعذر التأكد من حفظ التخصيص. أبقِ المبالغ وأعد المحاولة بالمفتاح نفسه."); }
    finally { submitting.current = false; setBusy(false); }
    if (committed) {
      const refreshed = await Promise.allSettled([load(), onChanged()]);
      if (refreshed.some((result) => result.status === "rejected")) setError("حُفظ التخصيص، لكن تعذر تحديث الحساب. أعد تحميل الصفحة لعرض الرصيد الحالي.");
      else setNotice("حُفظ التخصيص. يمكن تصحيح خطأ بتسجيل عكس مستقل مع سبب، ثم تخصيص جديد.");
      focus(`${prefix}-title`);
    }
  }

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
    const targets = chosen.map((fee) => ({ attempt_id: fee.attempt_id, amount: amounts[fee.attempt_id].trim() }));
    if (!chosen.some((fee) => fee.branch_id !== options.payment.branch_id)) { await commitAllocation(targets); return; }
    if (preview) { setConfirmCrossBranch(true); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`${path}/allocations/preview`, "POST", { targets, version: options.version });
      if (!response.ok) {
        if (response.status === 409) setConflict(true);
        setError(response.status === 409 ? "تغير الحساب أو الرصيد. حمّل أحدث البيانات وراجع المبالغ." : await responseMessage(response));
        return;
      }
      setPreview(await response.json() as AllocationPreview);
      setNotice("راجع فرع استلام الدفعة وفروع الرسوم والأثر، ثم اعتمد استخدام الرصيد صراحةً.");
      focus(`${prefix}-preview`);
    } catch { setError("تعذرت معاينة استخدام الرصيد. تحقق من الاتصال وأعد المحاولة."); }
    finally { setBusy(false); }
  }

  async function reverse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!options || !reversing || submitting.current || conflict) return;
    if (!reason.trim()) { setError("أدخل سبب عكس التخصيص."); focus(`${prefix}-reason`); return; }
    submitting.current = true; setBusy(true); setError(""); setNotice("");
    let committed = false;
    try {
      requestId.current ??= newSubmissionId();
      const response = await centerRequest(`students/${studentId}/allocations/${reversing}/reverse`, "POST", {
        reason: reason.trim(), version: options.version, request_id: requestId.current,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setUncertain(false); setError("تغير التخصيص أو الحساب. حمّل أحدث البيانات قبل التصحيح."); }
        else if (response.status >= 500) { setUncertain(true); setError("تعذر التأكد من حفظ العكس. أبقِ السبب وأعد المحاولة بالمفتاح نفسه."); }
        else { setUncertain(false); setError(await responseMessage(response)); }
        return;
      }
      setReason(""); setReversing(null); requestId.current = null; setUncertain(false);
      committed = true;
    } catch { setUncertain(true); setError("تعذر التأكد من حفظ العكس. أبقِ السبب وأعد المحاولة بالمفتاح نفسه."); }
    finally { submitting.current = false; setBusy(false); }
    if (committed) {
      const refreshed = await Promise.allSettled([load(options.pagination.page, options.pagination.history_page), onChanged()]);
      if (refreshed.some((result) => result.status === "rejected")) setError("سُجل عكس التخصيص، لكن تعذر تحديث الحساب. أعد تحميل الصفحة لعرض الرصيد الحالي.");
      else setNotice("سُجل عكس التخصيص مع سببه. الرصيد متاح الآن لتخصيص جديد.");
      focus(`${prefix}-title`);
    }
  }

  async function correction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!options || !correcting || submitting.current || conflict) return;
    if (!correctionTarget) { setError("اختر التسجيل الذي يجب أن يستفيد من الدفعة."); focus(`${prefix}-correction-target`); return; }
    if (!correctionReason.trim()) { setError("أدخل سبب تصحيح التخصيص."); focus(`${prefix}-correction-reason`); return; }
    if (correctionPreview) { setConfirmCorrection(true); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`students/${studentId}/allocations/${correcting.id}/corrections/preview`, "POST", {
        target_attempt_id: correctionTarget.attempt_id, version: options.version,
      });
      if (!response.ok) {
        if (response.status === 409) setConflict(true);
        setError(response.status === 409 ? "تغير الحساب أو الرسوم. حمّل أحدث البيانات قبل التصحيح." : await responseMessage(response));
        return;
      }
      setCorrectionPreview(await response.json() as CorrectionPreview);
      setNotice("راجع التخصيص الأصلي ومصدر الدفعة والوجهة الجديدة وأثر الدين والرصيد قبل الاعتماد.");
      focus(`${prefix}-correction-preview`);
    } catch { setError("تعذرت معاينة التصحيح. تحقق من الاتصال وأعد المحاولة."); }
    finally { setBusy(false); }
  }

  async function commitCorrection() {
    if (!options || !correcting || !correctionTarget || !correctionPreview || submitting.current || conflict) return;
    submitting.current = true; setBusy(true); setError(""); setNotice("");
    let committed = false;
    try {
      requestId.current ??= newSubmissionId();
      const response = await centerRequest(`students/${studentId}/allocations/${correcting.id}/corrections`, "POST", {
        target_attempt_id: correctionTarget.attempt_id, reason: correctionReason.trim(),
        version: correctionPreview.version, request_id: requestId.current,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setCorrectionPreview(null); setUncertain(false); setError("تغير التخصيص أو الحساب. حمّل أحدث البيانات قبل التصحيح."); }
        else if (response.status >= 500) { setUncertain(true); setError("تعذر التأكد من حفظ التصحيح. أبقِ الوجهة والسبب وأعد المحاولة بالمفتاح نفسه."); }
        else { setUncertain(false); setError(await responseMessage(response)); }
        return;
      }
      requestId.current = null; setUncertain(false); setCorrecting(null); setCorrectionTarget(null);
      setCorrectionReason(""); setCorrectionPreview(null); committed = true;
    } catch { setUncertain(true); setError("تعذر التأكد من حفظ التصحيح. أبقِ الوجهة والسبب وأعد المحاولة بالمفتاح نفسه."); }
    finally { submitting.current = false; setBusy(false); }
    if (committed) {
      const refreshed = await Promise.allSettled([load(options.pagination.page, options.pagination.history_page), onChanged()]);
      if (refreshed.some((result) => result.status === "rejected")) setError("حُفظ التصحيح، لكن تعذر تحديث الحساب. أعد تحميل الصفحة لعرض الرصيد الحالي.");
      else setNotice("حُفظ التصحيح: عُكس التخصيص الخاطئ وسُجل التخصيص الصحيح دون تغيير الدفعة المقبوضة.");
      focus(`${prefix}-title`);
    }
  }

  const changePage = (page: number, historyPage: number) => {
    if (uncertain || busy) return;
    void load(page, historyPage);
  };
  const selectedCrossBranch = Boolean(options && Object.values(selectedFees).some((fee) => amounts[fee.attempt_id]?.trim()
    && fee.branch_id !== options.payment.branch_id));
  const correctionChoices = correcting ? [...(options?.fees ?? []), ...(correctionTarget ? [correctionTarget] : [])]
    .filter((fee, index, fees) => fee.attempt_id !== correcting.attempt_id
      && cents(fee.remaining_amount) >= cents(correcting.amount)
      && fees.findIndex((item) => item.attempt_id === fee.attempt_id) === index) : [];

  return <section className="context-card form-stack" aria-labelledby={`${prefix}-title`}>
    <h2 id={`${prefix}-title`} data-payment-allocation-title tabIndex={-1}>تخصيص الدفعة المستلمة في <bdi dir="ltr">{payment.received_on}</bdi></h2>
    <p>فرع الاستلام: {options?.payment.branch_name ?? payment.branch_name} — المبلغ: <bdi dir="ltr">{payment.amount} {payment.currency}</bdi> — المتاح حاليًا: <strong><bdi dir="ltr">{options?.payment.available_amount ?? payment.available_amount} {payment.currency}</bdi></strong></p>
    <p className="muted">اختر المحاولات والمبالغ صراحةً. استخدام الرصيد في فرع آخر يحتاج اعتمادًا ماليًا على الفرعين؛ لا يحدث عند النقل الدراسي تلقائيًا. التخصيص لا يغيّر الدفعة أو الرسوم الأصلية.</p>
    <CenterHeaderActions><Button id={`${prefix}-payment-note`} disabled={busy || dirty} onClick={() => setSelectedNote({ type: "payment", id: payment.id, label: "الدفعة" })}>ملاحظة الدفعة وتاريخها</Button></CenterHeaderActions>
    {selectedNote?.type === "payment" ? <FinancialEventNoteEditor studentId={studentId} type="payment" eventId={payment.id} label="الدفعة"
      onDirtyChange={setNoteDirty} onClose={() => { setSelectedNote(null); focus(`${prefix}-payment-note`); }} /> : null}
    {loading ? <p role="status">جارٍ تحميل الرسوم والحركات…</p> : null}
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {conflict ? <CenterHeaderActions><Button disabled={busy || uncertain} onClick={() => { requestId.current = null; void load(options?.pagination.page, options?.pagination.history_page); }}>تحميل أحدث الرصيد</Button></CenterHeaderActions> : null}
    {options?.can_allocate ? <>
      <form id={formId} noValidate onSubmit={allocate} className="form-stack">
        <h3>رسوم المحاولات المصرح بها</h3>
        {Object.values(selectedFees).some((fee) => amounts[fee.attempt_id]?.trim()) ? <p>المحاولات المحددة عبر الصفحات: {Object.values(selectedFees).filter((fee) => amounts[fee.attempt_id]?.trim()).length} — إجمالي المبالغ: <bdi dir="ltr">{(Object.values(selectedFees).reduce((sum, fee) => sum + (/^\d{1,10}(?:\.\d{1,2})?$/.test(amounts[fee.attempt_id] ?? "") ? cents(amounts[fee.attempt_id]) : 0), 0) / 100).toFixed(2)} {options.payment.currency}</bdi></p> : null}
        <FieldSet disabled={busy || uncertain || conflict} className="border-0 p-0"><FieldGroup>
          {options.fees.length ? options.fees.map((fee) => <FormField key={fee.id} id={`${prefix}-${fee.attempt_id}`}
            label={`${fee.branch_name} — ${fee.group_name ?? "مجموعة غير متاحة"} — محاولة ${fee.attempt_id.slice(0, 8)} بتاريخ ${fee.fee_created_at.slice(0, 10)} — المستحق الحالي ${fee.current_due}، المسدد ${fee.paid_amount}، المتبقي ${fee.remaining_amount} ${fee.currency}`}
            type="text" direction="ltr" value={amounts[fee.attempt_id] ?? ""}
            onChange={(value) => { setAmounts((items) => ({ ...items, [fee.attempt_id]: value })); setSelectedFees((items) => value.trim() ? { ...items, [fee.attempt_id]: fee } : Object.fromEntries(Object.entries(items).filter(([id]) => id !== fee.attempt_id))); setPreview(null); setError(""); requestId.current = null; }}
            disabled={cents(fee.remaining_amount) === 0}
            hint={`معرّف المحاولة ${fee.attempt_id}. أدخل المبلغ أو اتركه فارغًا.`} />) : <p className="muted">لا توجد رسوم في هذا الفرع.</p>}
        </FieldGroup></FieldSet>
      </form>
      {preview ? <section className="context-card form-stack" aria-labelledby={`${prefix}-preview`}>
        <h3 id={`${prefix}-preview`} tabIndex={-1}>معاينة استخدام الرصيد بين الفروع</h3>
        <p>مصدر الدفعة: {preview.source.branch_name}، دفعة <bdi dir="ltr">{preview.source.payment_id.slice(0, 8)}</bdi> — المتاح <bdi dir="ltr">{preview.source.available_before}</bdi> ← <strong><bdi dir="ltr">{preview.source.available_after} {preview.source.currency}</bdi></strong></p>
        {preview.targets.map((target) => <p key={target.attempt_id}>الوجهة: {target.branch_name}، {target.group_name ?? "مجموعة غير متاحة"}، محاولة <bdi dir="ltr">{target.attempt_id.slice(0, 8)}</bdi>: تخصيص <bdi dir="ltr">{target.amount} {preview.source.currency}</bdi>؛ المتبقي <bdi dir="ltr">{target.remaining_before}</bdi> ← <bdi dir="ltr">{target.remaining_after}</bdi></p>)}
      </section> : null}
      <CenterHeaderActions>
        <Button id={`${prefix}-submit`} form={formId} type="submit" variant="primary" busy={busy} disabled={conflict || !Object.values(selectedFees).length || cents(options.payment.available_amount) === 0}>{uncertain ? "التحقق من التخصيص" : selectedCrossBranch ? preview ? "اعتماد استخدام الرصيد بين الفروع" : "معاينة استخدام الرصيد بين الفروع" : "تخصيص المبالغ المحددة"}</Button>
        <Button disabled={busy || uncertain || !Object.values(amounts).some(Boolean)} onClick={() => { setAmounts({}); setSelectedFees({}); setPreview(null); requestId.current = null; setError(""); focus(options.fees[0] ? `${prefix}-${options.fees[0].attempt_id}` : `${prefix}-title`); }}>إلغاء المبالغ</Button>
      </CenterHeaderActions>
      {options.pagination.page > 1 || options.pagination.has_more ? <CenterHeaderActions>
        {options.pagination.page > 1 ? <Button disabled={busy || uncertain} onClick={() => changePage(options.pagination.page - 1, options.pagination.history_page)}>رسوم سابقة</Button> : null}
        {options.pagination.has_more ? <Button disabled={busy || uncertain} onClick={() => changePage(options.pagination.page + 1, options.pagination.history_page)}>رسوم تالية</Button> : null}
      </CenterHeaderActions> : null}
    </> : <p className="muted">لديك صلاحية عرض الحركات دون تخصيص مبالغ.</p>}
    <DataTable id={`${prefix}-history`} title="سجل التخصيص والعكس" rows={options?.history ?? []} rowKey={(row) => row.id} pageSize={20}
      searchText={(row) => `${row.target_branch_name} ${row.group_name ?? ""} ${row.attempt_id} ${row.amount} ${row.actor_name} ${row.reversal_reason ?? ""} ${row.corrected_allocation_id ?? ""}`}
      emptyMessage="لم تُسجل تخصيصات لهذه الدفعة." columns={[
        { key: "group", label: "المحاولة", render: (row) => <>{row.target_branch_name} — {row.group_name ?? "مجموعة غير متاحة"} — <bdi dir="ltr" title={row.attempt_id}>{row.attempt_id.slice(0, 8)}</bdi></> },
        { key: "amount", label: "المبلغ", render: (row) => <bdi dir="ltr">{row.amount} {row.currency}</bdi> },
        { key: "status", label: "الحالة", render: (row) => row.reversal_id
          ? row.reversal_kind === "correct"
            ? <>صُحح {row.corrected_allocation_id ? <>إلى تخصيص <bdi dir="ltr" title={row.corrected_allocation_id}>{row.corrected_allocation_id.slice(0, 8)}</bdi></> : "وأُعيد إلى الرصيد"} — {row.reversal_reason}</>
            : `معكوس: ${row.reversal_reason}` : "معتمد" },
        { key: "actor", label: "الموظف", render: (row) => row.actor_name },
        { key: "action", label: "إجراءات", actions: true, render: (row) => <span className="flex flex-wrap gap-2">
          <Button id={`${prefix}-allocation-note-${row.id}`} disabled={busy || uncertain || dirty} onClick={() => setSelectedNote({ type: "allocation", id: row.id, label: "التخصيص" })}>ملاحظة التخصيص</Button>
          {row.can_correct && !row.reversal_id ? <Button id={`${prefix}-reverse-${row.id}`} disabled={busy || uncertain || dirty} onClick={() => { setReversing(row.id); setReason(""); requestId.current = null; focus(`${prefix}-reason`); }}>عكس التخصيص</Button> : null}
          {row.can_correct && options?.can_allocate && !row.reversal_id ? <Button id={`${prefix}-correct-${row.id}`} disabled={busy || uncertain || dirty}
            onClick={() => { setCorrecting(row); setCorrectionTarget(null); setCorrectionReason(""); setCorrectionPreview(null); setReversing(null); requestId.current = null; focus(`${prefix}-correction-target`); }}>تصحيح التخصيص</Button> : null}
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
    {correcting ? <section className="form-stack" aria-label="تصحيح التخصيص">
      <h3>تصحيح التخصيص</h3>
      <p>التخصيص الخاطئ: {correcting.target_branch_name} — {correcting.group_name ?? "مجموعة غير متاحة"}، محاولة <bdi dir="ltr">{correcting.attempt_id.slice(0, 8)}</bdi> بمبلغ <bdi dir="ltr">{correcting.amount} {correcting.currency}</bdi>.</p>
      <p className="muted">اختر التسجيل الصحيح من الرسوم المعروضة. استخدم صفحات الرسوم للعثور على تسجيل آخر؛ يبقى اختيارك محفوظًا أثناء التنقل. لإرجاع المبلغ إلى الرصيد دون وجهة جديدة استخدم «عكس التخصيص».</p>
      <form id={correctionFormId} noValidate onSubmit={correction}>
        <FieldSet disabled={busy || conflict || uncertain} className="border-0 p-0"><FieldGroup>
          <ChoiceField id={`${prefix}-correction-target`} label="التسجيل الصحيح" value={correctionTarget?.attempt_id ?? "choose"}
            items={[{ value: "choose", label: "اختر تسجيلًا", disabled: true }, ...correctionChoices.map((fee) => ({ value: fee.attempt_id,
              label: `${fee.branch_name} — ${fee.group_name ?? "مجموعة غير متاحة"} — ${fee.remaining_amount} ${fee.currency} متبقي` }))]}
            onChange={(value) => { setCorrectionTarget(correctionChoices.find((fee) => fee.attempt_id === value) ?? null); setCorrectionPreview(null); setError(""); requestId.current = null; }} />
          <FormField id={`${prefix}-correction-reason`} label="سبب تصحيح التخصيص" type="text" value={correctionReason}
            onChange={(value) => { setCorrectionReason(value); setCorrectionPreview(null); setError(""); requestId.current = null; }}
            hint="سيبقى التخصيص والدفعة الأصليان ظاهرين مع سبب التصحيح ومن نفذه." />
        </FieldGroup></FieldSet>
      </form>
      {correctionPreview ? <section className="context-card form-stack" aria-labelledby={`${prefix}-correction-preview`}>
        <h4 id={`${prefix}-correction-preview`} tabIndex={-1}>معاينة التصحيح قبل الاعتماد</h4>
        <p>الدفعة الأصلية: {correctionPreview.source.branch_name}، مبلغ <bdi dir="ltr">{correctionPreview.source.received_amount} {correctionPreview.source.currency}</bdi> بتاريخ <bdi dir="ltr">{correctionPreview.source.received_on}</bdi>. لن تتغير.</p>
        <p>التسجيل الخاطئ: {correctionPreview.original.branch_name} — {correctionPreview.original.group_name ?? "مجموعة غير متاحة"}؛ المتبقي <bdi dir="ltr">{correctionPreview.original.remaining_before}</bdi> ← <bdi dir="ltr">{correctionPreview.original.remaining_after}</bdi>.</p>
        {correctionPreview.target ? <p>التسجيل الصحيح: {correctionPreview.target.branch_name} — {correctionPreview.target.group_name ?? "مجموعة غير متاحة"}؛ المتبقي <bdi dir="ltr">{correctionPreview.target.remaining_before}</bdi> ← <bdi dir="ltr">{correctionPreview.target.remaining_after}</bdi>.</p> : null}
        <p>الرصيد المتاح من الدفعة: <bdi dir="ltr">{correctionPreview.source.available_before}</bdi> ← <bdi dir="ltr">{correctionPreview.source.available_after} {correctionPreview.source.currency}</bdi>.</p>
        <p>رصيد الحساب المرئي: <bdi dir="ltr">{correctionPreview.account.available_before}</bdi> ← <bdi dir="ltr">{correctionPreview.account.available_after}</bdi>؛ المديونية: <bdi dir="ltr">{correctionPreview.account.debt_before}</bdi> ← <bdi dir="ltr">{correctionPreview.account.debt_after} {correctionPreview.source.currency}</bdi>.</p>
      </section> : null}
      <CenterHeaderActions>
        <Button id={`${prefix}-correction-submit`} form={correctionFormId} type="submit" variant="primary" busy={busy} disabled={conflict || !correctionTarget || !correctionReason.trim()}>{uncertain ? "التحقق من التصحيح" : correctionPreview ? "اعتماد التصحيح" : "معاينة التصحيح"}</Button>
        <Button disabled={busy || uncertain} onClick={() => { const trigger = correcting.id; setCorrecting(null); setCorrectionTarget(null); setCorrectionReason(""); setCorrectionPreview(null); requestId.current = null; setError(""); focus(`${prefix}-correct-${trigger}`); }}>إلغاء التصحيح</Button>
      </CenterHeaderActions>
    </section> : null}
    {confirmCrossBranch && preview ? <ConfirmationDialog title="اعتماد استخدام الرصيد بين الفروع"
      description={`ستستخدم ${preview.targets.reduce((sum, target) => sum + cents(target.amount), 0) / 100} ${preview.source.currency} من دفعة ${preview.source.branch_name} لسداد رسوم في ${Array.from(new Set(preview.targets.map(target => target.branch_name))).join("، ")}.`}
      confirmLabel="تأكيد التخصيص" onCancel={() => { setConfirmCrossBranch(false); focus(`${prefix}-submit`); }}
      onConfirm={() => { setConfirmCrossBranch(false); void commitAllocation(preview.targets.map(target => ({ attempt_id: target.attempt_id, amount: target.amount }))); }} /> : null}
    {confirmCorrection && correctionPreview ? <ConfirmationDialog title="اعتماد تصحيح التخصيص"
      description={`سيُعكس تخصيص ${correctionPreview.original.amount} ${correctionPreview.source.currency} من ${correctionPreview.original.branch_name} ويُسجل على ${correctionPreview.target?.branch_name ?? "الرصيد المتاح"}، مع بقاء الدفعة الأصلية.`}
      confirmLabel="تأكيد التصحيح" onCancel={() => { setConfirmCorrection(false); focus(`${prefix}-correction-submit`); }}
      onConfirm={() => { setConfirmCorrection(false); void commitCorrection(); }} /> : null}
    <CenterHeaderActions><Button disabled={busy || uncertain || dirty} onClick={onClose}>إغلاق تفاصيل الدفعة</Button></CenterHeaderActions>
  </section>;
}
