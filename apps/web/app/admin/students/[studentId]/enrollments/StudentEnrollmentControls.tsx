"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions, CenterPageActions } from "@/components/CenterShell";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { DataTable } from "@/components/DataTable";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { centerRequest, newSubmissionId, responseFieldErrors, responseMessage } from "@/lib/client-api";
import type { StudyEnrollmentContext } from "@/lib/server-context";

export function StudentEnrollmentControls({ initial, search }: { initial: StudyEnrollmentContext; search: string }) {
  const router = useRouter();
  const prefix = useId();
  const formId = `${prefix}-enrollment`;
  const [loadedInitial, setLoadedInitial] = useState(initial);
  const [current, setCurrent] = useState(initial);
  const [groupId, setGroupId] = useState("");
  const [joinedOn, setJoinedOn] = useState("");
  const [discount, setDiscount] = useState("0.00");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pendingSearch, setPendingSearch] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  if (loadedInitial !== initial) {
    setLoadedInitial(initial); setCurrent(initial);
    if (groupId && !initial.groups.some(group => group.id === groupId)) {
      setGroupId(""); setJoinedOn(""); setDiscount("0.00"); setReason("");
    }
  }
  const studentId = current.student.id;
  const selected = current.groups.find(group => group.id === groupId);
  const discountAllowed = Boolean(selected && (current.permissions.can_manage_center ||
    current.permissions.branch_actions?.[String(selected.branch_id)]?.includes("fees.discount")));
  const dirty = Boolean(groupId || joinedOn || discount !== "0.00" || reason);
  const path = `/admin/students/${studentId}/enrollments`;
  const query = new URLSearchParams({ page: String(current.pagination.page), groups_page: String(current.pagination.groups_page), ...(search ? { q: search } : {}) });
  const endpoint = `students/${studentId}/enrollments?${query}`;
  const focus = (field: string) => requestAnimationFrame(() => document.getElementById(`${prefix}-${field}`)?.focus());

  function reset() {
    setGroupId(""); setJoinedOn(""); setDiscount("0.00"); setReason("");
    setFieldErrors({}); setError(""); setConflict(false); setUncertain(false); requestId.current = null;
    focus("group_id");
  }

  async function reload() {
    if (submitting.current) return;
    setBusy(true);
    try {
      const response = await centerRequest(endpoint, "GET");
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const fresh = await response.json() as StudyEnrollmentContext;
      setCurrent(fresh); setConflict(false); setUncertain(false); requestId.current = null;
      if (!fresh.groups.some(group => group.id === groupId)) setGroupId("");
      setError(""); setNotice("حُمّلت المحاولات والأرصدة الحالية. راجع المجموعة والرسوم قبل إعادة المحاولة.");
      router.refresh();
    } catch { setError("تعذر تحميل أحدث بيانات التسجيل. تحقق من الاتصال وأعد المحاولة."); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || conflict || !current.student.currency || current.student.status !== "active") return;
    const errors: Record<string, string> = {};
    if (!selected) errors.group_id = "اختر مجموعة من الفروع المصرح بها.";
    if (!joinedOn) errors.joined_on = "أدخل تاريخ انضمام الطالب الفعلي.";
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(discount)) errors.discount = "أدخل خصمًا غير سالب حتى منزلتين عشريتين.";
    if (selected && Number(discount) > Number(selected.approved_price)) errors.discount = "الخصم أكبر من السعر المعتمد.";
    if (Number(discount) > 0 && !discountAllowed) errors.discount = "ليس لديك صلاحية خصم الرسوم في هذا الفرع.";
    if (Number(discount) > 0 && !reason.trim()) errors.discount_reason = "أدخل سبب الخصم.";
    if (Object.keys(errors).length) {
      setFieldErrors(errors); setError("راجع بيانات التسجيل والخصم."); focus(Object.keys(errors)[0]); return;
    }
    submitting.current = true; setBusy(true); setError(""); setNotice(""); setFieldErrors({});
    try {
      requestId.current ??= newSubmissionId();
      const response = await centerRequest(`students/${studentId}/enrollments`, "POST", {
        group_id: groupId, group_revision: selected!.revision, currency_revision: current.student.currency_revision, joined_on: joinedOn, discount,
        discount_reason: Number(discount) > 0 ? reason.trim() : null,
        version: current.student.version, request_id: requestId.current,
      });
      if (!response.ok) {
        if (response.status === 409) {
          const conflictCode = (await response.json().catch(() => ({})) as { code?: string }).code;
          setConflict(true); setUncertain(false);
          setError(conflictCode === "student_suspended"
            ? "أُوقف ملف الطالب بعد فتح الصفحة؛ لا يمكن تسجيله الآن. حمّل أحدث البيانات لمراجعة حالته."
            : "تغير حساب الطالب أو تسجيله أو سعر المجموعة أو عملة المركز. حمّل أحدث البيانات وراجع الطلب.");
        } else {
          const errors = await responseFieldErrors(response); setFieldErrors(errors);
          setError(await responseMessage(response)); if (Object.keys(errors).length) focus(Object.keys(errors)[0]);
        }
        return;
      }
      reset(); setNotice("سُجلت المحاولة ورسومها معًا. بقي الرصيد المقدم دون تخصيص.");
      try {
        const fresh = await centerRequest(endpoint, "GET");
        if (fresh.ok) setCurrent(await fresh.json() as StudyEnrollmentContext);
      } catch { setNotice("حُفظ التسجيل، لكن تعذر تحديث العرض. حمّل الصفحة لمراجعته."); }
      router.refresh();
    } catch {
      setUncertain(true); setError("تعذر التأكد من التسجيل. أبقِ البيانات كما هي وأعد الطلب للتحقق بالمفتاح نفسه دون تكرار الرسوم.");
    } finally { submitting.current = false; setBusy(false); }
  }

  const page = (number: number) => `${path}?${new URLSearchParams({ page: String(number), groups_page: String(current.pagination.groups_page), ...(search ? { q: search } : {}) })}`;
  const groupsPage = (number: number) => `${path}?${new URLSearchParams({ page: String(current.pagination.page), groups_page: String(number), ...(search ? { q: search } : {}) })}`;
  function searchGroups(value: string) {
    const href = `${path}?${new URLSearchParams({ page: String(current.pagination.page), groups_page: "1", ...(value ? { q: value } : {}) })}`;
    if (dirty) { setPendingSearch(href); return; }
    router.push(href);
  }

  return <>
    <CenterPageActions context={current} />
    <UnsavedChangesGuard dirty={dirty} guardHistory onDiscard={reset} />
    {pendingSearch ? <ConfirmationDialog title="مغادرة دون حفظ" description="لديك بيانات تسجيل لم تُحفظ. هل تريد مسحها والبحث عن مجموعات أخرى؟" confirmLabel="مسح البيانات والبحث" onCancel={() => setPendingSearch(null)} onConfirm={() => {
      reset(); router.push(pendingSearch); setPendingSearch(null);
    }} /> : null}
    <section className="context-card form-stack" aria-label="ملخص التسجيل والرصيد">
      <h2>{current.student.name} — رقم {current.student.student_number.toLocaleString("ar-EG")}</h2>
      <p>المديونية في فروع صلاحيتك: <strong><bdi dir="ltr">{current.balance.debt} {current.student.currency ?? ""}</bdi></strong></p>
      <p>الرصيد المقدم المتاح في فروع صلاحيتك: <strong><bdi dir="ltr">{current.balance.available_credit} {current.student.currency ?? ""}</bdi></strong></p>
      {Number(current.balance.debt) > 0 ? <InlineNotice tone="warning">توجد مديونية. يمكنك الاستمرار في التسجيل دون تجاوز مالي؛ راجع المبلغ مع الطالب.</InlineNotice> : null}
      {Number(current.balance.available_credit) > 0 ? <p className="muted">يوجد رصيد مقدم. يمكن لصاحب الصلاحية المالية استخدامه في مسار التخصيص؛ لا يُستخدم تلقائيًا هنا.</p> : null}
      {!current.student.currency ? <InlineNotice tone="warning">اختر عملة المركز من حساب الطالب قبل تسجيل رسوم المحاولة.</InlineNotice> : null}
      {current.student.status !== "active" ? <InlineNotice tone="warning">الطالب موقوف؛ لا يمكن تسجيل محاولة جديدة.</InlineNotice> : null}
    </section>
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {conflict ? <CenterHeaderActions><Button disabled={busy} onClick={reload}>تحميل أحدث البيانات</Button></CenterHeaderActions> : null}
    <section className="context-card form-stack" aria-labelledby={`${prefix}-title`}>
      <h2 id={`${prefix}-title`}>تسجيل محاولة دراسة</h2>
      <p className="muted">يثبت سعر المجموعة وخطتها عند التسجيل، حتى لو تغير السعر لاحقًا. تاريخ الانضمام لا يسقط محاضرات الخطة السابقة.</p>
      <form id={formId} onSubmit={save} noValidate><FieldGroup>
        <Field data-invalid={Boolean(fieldErrors.group_id)}>
          <FieldLabel htmlFor={`${prefix}-group_id`}>المجموعة الأساسية</FieldLabel>
          <NativeSelect id={`${prefix}-group_id`} value={groupId} onChange={event => { setGroupId(event.target.value); setFieldErrors({}); }} aria-invalid={Boolean(fieldErrors.group_id)}>
            <NativeSelectOption value="">اختر مجموعة</NativeSelectOption>
            {current.groups.map(group => <NativeSelectOption key={group.id} value={group.id}>{group.branch_name} — {group.level_name} — {group.name} ({group.approved_price} {current.student.currency ?? ""})</NativeSelectOption>)}
          </NativeSelect>
          {fieldErrors.group_id ? <FieldError id={`${prefix}-group_id-error`}>{fieldErrors.group_id}</FieldError> : null}
        </Field>
        <FormField id={`${prefix}-joined_on`} label="تاريخ الانضمام الفعلي" type="date" value={joinedOn} onChange={value => { setJoinedOn(value); setFieldErrors({}); }} error={fieldErrors.joined_on} />
        <FormField id={`${prefix}-discount`} label="الخصم" type="text" direction="ltr" value={discount} onChange={value => { setDiscount(value); setFieldErrors({}); }} error={fieldErrors.discount} disabled={!discountAllowed} hint={discountAllowed ? "يمكن خصم السعر كاملًا مع سبب مسجل." : "يتطلب صلاحية خصم مستقلة في فرع المجموعة."} />
        {discountAllowed && Number(discount) > 0 ? <FormField id={`${prefix}-discount_reason`} label="سبب الخصم" value={reason} onChange={value => { setReason(value); setFieldErrors({}); }} error={fieldErrors.discount_reason} /> : null}
      </FieldGroup></form>
      {selected ? <p>السعر الأصلي <bdi dir="ltr">{selected.approved_price}</bdi> — الصافي بعد الخصم <strong><bdi dir="ltr">{Math.max(0, Number(selected.approved_price) - (Number(discount) || 0)).toFixed(2)} {current.student.currency ?? ""}</bdi></strong></p> : null}
      <CenterHeaderActions>
        <Button form={formId} type="submit" variant="primary" busy={busy} disabled={conflict || !current.student.currency || current.student.status !== "active"}>{uncertain ? "التحقق من التسجيل" : "تسجيل الطالب والرسوم"}</Button>
        <Button disabled={busy || uncertain || !dirty} onClick={reset}>إلغاء البيانات</Button>
      </CenterHeaderActions>
    </section>
    <DataTable id="enrollment-group-choices" title="المجموعات المتاحة للتسجيل" rows={current.groups} rowKey={row => row.id}
      serverPagination={{ page: current.pagination.groups_page, hasMore: current.pagination.groups_has_more, batchSize: 50,
        previousHref: groupsPage(current.pagination.groups_page - 1),
        nextHref: groupsPage(current.pagination.groups_page + 1) }}
      serverSearch={{ value: search, onSearch: searchGroups }}
      searchText={row => `${row.name} ${row.level_name} ${row.branch_name}`}
      emptyMessage="لا توجد مجموعات في فروع تسجيل الطالب ضمن هذه الدفعة." description="ابحث باسم المجموعة، ثم اخترها في نموذج التسجيل. تظهر حتى ٥٠ مجموعة في الدفعة."
      columns={[
        { key: "name", label: "المجموعة", render: row => row.name },
        { key: "level", label: "المستوى", render: row => row.level_name },
        { key: "branch", label: "الفرع", render: row => row.branch_name },
        { key: "price", label: "السعر المعتمد", render: row => <bdi dir="ltr">{row.approved_price} {current.student.currency ?? ""}</bdi> },
      ]} />
    <DataTable id="student-attempts" title="محاولات الدراسة" rows={current.attempts} rowKey={row => row.id}
      serverPagination={{ page: current.pagination.page, hasMore: current.pagination.has_more, batchSize: 20,
        previousHref: page(current.pagination.page - 1),
        nextHref: page(current.pagination.page + 1) }}
      searchText={row => `${row.group_name} ${row.level_name} ${row.fee.net_amount}`}
      emptyMessage="لا توجد محاولات دراسة في فروع صلاحيتك." description="آخر ٢٠ محاولة في الدفعة الحالية. الرسوم المعتمدة محفوظة مع سبب الخصم والموظف."
      columns={[
        { key: "group", label: "المجموعة / المستوى", render: row => `${row.group_name} — ${row.level_name}` },
        { key: "joined", label: "الانضمام", render: row => <bdi dir="ltr">{row.joined_on}</bdi> },
        { key: "requirements", label: "متطلبات الخطة", render: row => row.requirements_count.toLocaleString("ar-EG") },
        { key: "fee", label: "الرسوم بعد الخصم", render: row => <bdi dir="ltr">{row.fee.net_amount} {row.fee.currency}</bdi> },
        { key: "actor", label: "سجلها", render: row => row.fee.actor_name },
      ]} />
  </>;
}
