"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions, CenterPageActions } from "@/components/CenterShell";
import { DataTable } from "@/components/DataTable";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { Field, FieldError, FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { buttonVariants } from "@/components/ui/button";
import { centerRequest, newSubmissionId, responseFieldErrors, responseMessage } from "@/lib/client-api";
import type { StudentAccountContext } from "@/lib/server-context";
import { paymentMethodLabels } from "@/lib/student-finance";
import { StudentPaymentAllocations } from "./StudentPaymentAllocations";

const currencies = ["EGP", "SAR", "AED", "USD", "EUR", "GBP"];

function SelectField({ id, label, value, options, onChange, error }: {
  id: string; label: string; value: string; options: { value: string; label: string }[];
  onChange: (value: string) => void; error?: string;
}) {
  return <Field data-invalid={Boolean(error)}>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <NativeSelect id={id} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined}>
      <NativeSelectOption value="">اختر {label}</NativeSelectOption>
      {options.map((option) => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}
    </NativeSelect>
    {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
  </Field>;
}

export function StudentFinanceControls({ initial, search }: { initial: StudentAccountContext; search: string }) {
  const router = useRouter();
  const formPrefix = useId();
  const [loadedInitial, setLoadedInitial] = useState(initial);
  const [current, setCurrent] = useState(initial);
  const [currency, setCurrency] = useState(initial.account.currency ?? "");
  const [branch, setBranch] = useState(initial.recordable_branches[0] ? String(initial.recordable_branches[0].id) : "");
  const [method, setMethod] = useState("cash");
  const [receivedOn, setReceivedOn] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [selectedPaymentId, setSelectedPaymentId] = useState<string | null>(null);
  const [allocationDirty, setAllocationDirty] = useState(false);
  const submitting = useRef(false);
  const requestId = useRef<string | null>(null);
  if (loadedInitial !== initial) {
    setLoadedInitial(initial); setCurrent(initial); setCurrency(initial.account.currency ?? "");
    if (!initial.recordable_branches.some((item) => String(item.id) === branch)) {
      setBranch(initial.recordable_branches[0] ? String(initial.recordable_branches[0].id) : "");
    }
  }

  const studentId = current.account.student_id;
  const accountPath = `students/${studentId}/account?${new URLSearchParams({
    page: String(current.pagination.page), branches_page: String(current.pagination.branches_page), ...(search ? { q: search } : {}),
  })}`;
  const currencyForm = `${formPrefix}-currency`;
  const paymentForm = `${formPrefix}-payment`;
  const paymentDirty = Boolean(amount || receivedOn || method !== "cash" ||
    (current.recordable_branches[0] && branch !== String(current.recordable_branches[0].id)));
  const dirty = Boolean((currency && currency !== current.account.currency) || paymentDirty || allocationDirty);
  const selectedPayment = current.payments.find((item) => item.id === selectedPaymentId);

  function focus(field: string) {
    requestAnimationFrame(() => document.getElementById(`${formPrefix}-${field}`)?.focus());
  }

  async function reload() {
    if (submitting.current) return;
    setBusy(true);
    try {
      const response = await centerRequest(accountPath, "GET");
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const payload = await response.json() as StudentAccountContext;
      setCurrent(payload); setCurrency(payload.account.currency ?? ""); setConflict(false); setError("");
      setNotice("حُمّلت أحدث حركة. راجع بيانات الدفعة قبل إعادة المحاولة.");
      router.refresh();
    } catch { setError("تعذر تحميل الحساب. تحقق من الاتصال وأعد المحاولة."); }
    finally { setBusy(false); }
  }

  async function refreshAfterAllocation() {
    try {
      const response = await centerRequest(accountPath, "GET");
      if (!response.ok) { setError("حُفظت الحركة، لكن تعذر تحديث ملخص الحساب. حمّل أحدث الحساب."); return; }
      setCurrent(await response.json() as StudentAccountContext);
      router.refresh();
    } catch { setError("حُفظت الحركة، لكن تعذر تحديث ملخص الحساب. حمّل أحدث الحساب."); }
  }

  async function saveCurrency(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || current.account.currency_locked) return;
    if (!currency) { setFieldErrors({ currency: "اختر عملة المركز." }); focus("currency"); return; }
    submitting.current = true; setBusy(true); setError(""); setNotice(""); setFieldErrors({});
    try {
      const response = await centerRequest("financial-currency", "PATCH", { currency, revision: current.account.currency_revision });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setError("تغيرت عملة المركز أو سُجلت حركة. حمّل الحساب الحالي."); }
        else { const errors = await responseFieldErrors(response); setFieldErrors(errors); setError(await responseMessage(response)); if (Object.keys(errors).length) focus("currency"); }
        return;
      }
      const saved = await response.json() as { currency: string; revision: number };
      setCurrent((value) => ({ ...value, account: { ...value.account, currency: saved.currency, currency_revision: saved.revision } }));
      setNotice("حُفظت عملة المركز. ستثبت بعد أول حركة مالية."); router.refresh();
    } catch { setConflict(true); setError("تعذر التأكد من حفظ العملة. حمّل أحدث بيانات المركز."); }
    finally { submitting.current = false; setBusy(false); }
  }

  async function savePayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || conflict) return;
    const errors: Record<string, string> = {};
    if (!branch) errors.branch_id = "اختر فرع استلام الدفعة.";
    if (!method) errors.method = "اختر طريقة الاستلام.";
    if (!receivedOn) errors.received_on = "أدخل تاريخ الاستلام.";
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) errors.amount = "أدخل مبلغًا موجبًا حتى منزلتين عشريتين.";
    if (Object.keys(errors).length) { setFieldErrors(errors); setError("راجع بيانات الدفعة."); focus(Object.keys(errors)[0]); return; }
    submitting.current = true; setBusy(true); setError(""); setNotice(""); setFieldErrors({});
    try {
      requestId.current ??= newSubmissionId();
      const response = await centerRequest(`students/${studentId}/payments`, "POST", {
        branch_id: Number(branch), method, received_on: receivedOn, amount, request_id: requestId.current,
        version: current.account.version,
      });
      if (!response.ok) {
        if (response.status === 409) {
          const data = await response.json() as { code?: string; payment?: { amount: string; currency: string } };
          if (data.code === "payment_request_changed" && data.payment) {
            setAmount(""); setReceivedOn(""); setMethod("cash"); requestId.current = null; setUncertain(false);
            setNotice(`حُفظ الطلب الأصلي بمبلغ ${data.payment.amount} ${data.payment.currency}. راجع الحركات قبل تسجيل دفعة أخرى.`);
            router.refresh(); return;
          }
          setUncertain(false); setConflict(true); setError("تغير الحساب منذ فتح الصفحة. حمّل أحدث الحركات وراجع الدفعة قبل إعادة المحاولة.");
        } else { setUncertain(false); const errors = await responseFieldErrors(response); setFieldErrors(errors); setError(await responseMessage(response)); if (Object.keys(errors).length) focus(Object.keys(errors)[0]); }
        return;
      }
      setAmount(""); setReceivedOn(""); setMethod("cash");
      setBranch(current.recordable_branches[0] ? String(current.recordable_branches[0].id) : "");
      requestId.current = null; setUncertain(false);
      setNotice("سُجلت الدفعة المقدمة دون تخصيصها لمجموعة. لا يمكن تعديل الحركة المعتمدة أو حذفها.");
      try {
        const fresh = await centerRequest(accountPath, "GET");
        if (fresh.ok) { const payload = await fresh.json() as StudentAccountContext; setCurrent(payload); setCurrency(payload.account.currency ?? ""); }
      } catch { setNotice("حُفظت الدفعة، لكن تعذر تحديث القائمة. حمّل الحساب لمراجعتها."); }
      router.refresh(); focus("amount");
    } catch { setUncertain(true); setError("تعذر التأكد من استلام الدفعة. أبقِ البيانات كما هي وأعد المحاولة بالمفتاح نفسه للتحقق دون تكرارها."); }
    finally { submitting.current = false; setBusy(false); }
  }

  const paymentPage = (page: number) => `/admin/students/${studentId}/account?${new URLSearchParams({ page: String(page), branches_page: String(current.pagination.branches_page), ...(search ? { q: search } : {}) })}`;
  const branchPage = (page: number) => `/admin/students/${studentId}/account?${new URLSearchParams({ page: String(current.pagination.page), branches_page: String(page), ...(search ? { q: search } : {}) })}`;
  const cancelCurrency = () => { setCurrency(current.account.currency ?? ""); setFieldErrors({}); setError(""); focus("currency"); };
  const cancelPayment = () => {
    if (uncertain) return;
    setAmount(""); setReceivedOn(""); setMethod("cash");
    setBranch(current.recordable_branches[0] ? String(current.recordable_branches[0].id) : "");
    requestId.current = null; setFieldErrors({}); setError(""); setConflict(false); focus("branch_id");
  };

  return <>
    <CenterPageActions context={current} />
    <UnsavedChangesGuard dirty={dirty} guardHistory />
    <section className="context-card form-stack" aria-label="ملخص الحساب المالي">
      <h2>{current.account.student_name} — رقم {current.account.student_number.toLocaleString("ar-EG")}</h2>
      <p>إجمالي الدفعات المستلمة ضمن فروع صلاحيتك: <strong><bdi dir="ltr">{current.account.received_total} {current.account.currency ?? ""}</bdi></strong></p>
      <p>الرصيد غير المخصص: <strong><bdi dir="ltr">{current.account.available_balance} {current.account.currency ?? ""}</bdi></strong></p>
      <p>إجمالي الرسوم: <strong><bdi dir="ltr">{current.account.due_total} {current.account.currency ?? ""}</bdi></strong> — المسدد بالتخصيص: <strong><bdi dir="ltr">{current.account.paid_total} {current.account.currency ?? ""}</bdi></strong></p>
      <p>المديونية المتبقية: <strong><bdi dir="ltr">{current.account.debt} {current.account.currency ?? ""}</bdi></strong></p>
      <p className="muted">قد توجد حركات في فروع أخرى لا تملك صلاحية رؤيتها.</p>
      {current.account.currency_locked ? <p>عملة المركز ثابتة بعد أول حركة: <bdi dir="ltr">{current.account.currency}</bdi></p> : null}
    </section>
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {conflict ? <CenterHeaderActions><Button disabled={busy} onClick={reload}>تحميل أحدث الحساب</Button></CenterHeaderActions> : null}
    {current.permissions.can_manage_center && !current.account.currency_locked ? <section className="context-card form-stack" aria-labelledby={`${formPrefix}-currency-title`}>
      <h2 id={`${formPrefix}-currency-title`}>عملة المركز</h2>
      <p className="muted">اختر العملة قبل أول دفعة. بعد اعتماد أول حركة لا يمكن تغييرها.</p>
      <form id={currencyForm} noValidate onSubmit={saveCurrency}><FieldGroup>
        <SelectField id={`${formPrefix}-currency`} label="عملة المركز" value={currency} options={currencies.map((value) => ({ value, label: value }))} onChange={(value) => { setCurrency(value); setFieldErrors({}); }} error={fieldErrors.currency} />
      </FieldGroup></form>
      <CenterHeaderActions><Button form={currencyForm} type="submit" variant="primary" busy={busy} disabled={conflict || currency === current.account.currency}>حفظ عملة المركز</Button><Button disabled={busy || currency === current.account.currency} onClick={cancelCurrency}>إلغاء تعديل العملة</Button></CenterHeaderActions>
    </section> : null}
    {current.recordable_branches.length ? <section className="context-card form-stack" aria-labelledby={`${formPrefix}-payment-title`}>
      <h2 id={`${formPrefix}-payment-title`}>استلام دفعة مقدمة</h2>
      <p className="muted">حدد الفرع الذي استلم المبلغ وطريقة وتاريخ الاستلام. تُحفظ الدفعة في حساب الطالب دون تخصيص.</p>
      <form id={paymentForm} noValidate onSubmit={savePayment}><FieldSet disabled={uncertain} className="border-0 p-0"><FieldGroup>
        <SelectField id={`${formPrefix}-branch_id`} label="فرع الاستلام" value={branch} options={current.recordable_branches.map((item) => ({ value: String(item.id), label: item.name }))} onChange={(value) => { setBranch(value); setFieldErrors({}); }} error={fieldErrors.branch_id} />
        <SelectField id={`${formPrefix}-method`} label="طريقة الاستلام" value={method} options={Object.entries(paymentMethodLabels).map(([value, label]) => ({ value, label }))} onChange={(value) => { setMethod(value); setFieldErrors({}); }} error={fieldErrors.method} />
        <FormField id={`${formPrefix}-received_on`} label="تاريخ الاستلام" type="date" value={receivedOn} onChange={(value) => { setReceivedOn(value); setFieldErrors({}); }} error={fieldErrors.received_on} />
        <FormField id={`${formPrefix}-amount`} label={`المبلغ${current.account.currency ? ` (${current.account.currency})` : ""}`} type="text" direction="ltr" value={amount} onChange={(value) => { setAmount(value); setFieldErrors({}); }} error={fieldErrors.amount} hint="مبلغ موجب حتى منزلتين عشريتين." />
      </FieldGroup></FieldSet></form>
      <CenterHeaderActions><Button form={paymentForm} type="submit" variant="primary" busy={busy} disabled={conflict || !current.account.currency}>{uncertain ? "التحقق من الدفعة" : "تسجيل الدفعة"}</Button><Button disabled={busy || uncertain || !paymentDirty} onClick={cancelPayment}>إلغاء بيانات الدفعة</Button></CenterHeaderActions>
      {current.pagination.branches_page > 1 || current.pagination.branches_has_more ? <CenterHeaderActions>
        {current.pagination.branches_page > 1 ? <Link className={buttonVariants({ variant: "outline" })} href={branchPage(current.pagination.branches_page - 1)}>فروع الاستلام السابقة</Link> : null}
        {current.pagination.branches_has_more ? <Link className={buttonVariants({ variant: "outline" })} href={branchPage(current.pagination.branches_page + 1)}>فروع الاستلام التالية</Link> : null}
      </CenterHeaderActions> : null}
    </section> : null}
    <DataTable id="student-payments" title="حركات الدفعات المقدمة" rows={current.payments} rowKey={(row) => row.id} pageSize={20}
      serverSearch={{ value: search, onSearch: (value) => router.push(`/admin/students/${studentId}/account?${new URLSearchParams({ page: "1", branches_page: String(current.pagination.branches_page), ...(value ? { q: value } : {}) })}`) }}
      searchText={(row) => `${row.branch_name ?? ""} ${paymentMethodLabels[row.method] ?? row.method} ${row.amount} ${row.actor_name}`}
      emptyMessage="لا توجد دفعات مقدمة في فروع صلاحيتك." description="آخر ٢٠ حركة في الدفعة المعروضة. الحركات المعتمدة محفوظة دون تعديل أو حذف."
      columns={[
        { key: "date", label: "تاريخ الاستلام", render: (row) => <bdi dir="ltr">{row.received_on}</bdi> },
        { key: "branch", label: "فرع الاستلام", render: (row) => row.branch_name ?? `فرع ${row.branch_id}` },
        { key: "amount", label: "المبلغ", render: (row) => <bdi dir="ltr">{row.amount} {row.currency}</bdi> },
        { key: "allocated", label: "المخصص", render: (row) => <bdi dir="ltr">{row.allocated_amount} {row.currency}</bdi> },
        { key: "available", label: "المتاح", render: (row) => <bdi dir="ltr">{row.available_amount} {row.currency}</bdi> },
        { key: "method", label: "الطريقة", render: (row) => paymentMethodLabels[row.method] ?? row.method },
        { key: "actor", label: "الموظف", render: (row) => row.actor_name },
        { key: "allocations", label: "التخصيصات", render: (row) => <Button disabled={busy || dirty} onClick={() => { setSelectedPaymentId(row.id); requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-payment-allocation-title]")?.focus()); }}>عرض وتخصيص</Button> },
      ]} />
    {selectedPayment ? <StudentPaymentAllocations studentId={studentId} payment={selectedPayment}
      onClose={() => setSelectedPaymentId(null)} onChanged={refreshAfterAllocation} onDirtyChange={setAllocationDirty} /> : null}
    <CenterHeaderActions>
      {current.pagination.page > 1 ? <Link className={buttonVariants({ variant: "outline" })} href={paymentPage(current.pagination.page - 1)}>الحركات السابقة</Link> : null}
      {current.pagination.has_more ? <Link className={buttonVariants({ variant: "outline" })} href={paymentPage(current.pagination.page + 1)}>الحركات التالية</Link> : null}
    </CenterHeaderActions>
  </>;
}
