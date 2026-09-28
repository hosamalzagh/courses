"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions, CenterPageActions } from "@/components/CenterShell";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { DataTable } from "@/components/DataTable";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { PrefetchLink } from "@/components/PrefetchLink";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { centerRequest, newSubmissionId, responseFieldErrors, responseMessage } from "@/lib/client-api";
import type { StudyEnrollmentContext, StudyAttemptNote } from "@/lib/server-context";
import { StudyAttemptNoteEditor } from "./StudyAttemptNoteEditor";
import { StudyWithdrawalEditor } from "./StudyWithdrawalEditor";
import { StudyWaitlistEditor } from "./StudyWaitlistEditor";

export function StudentEnrollmentControls({ initial, search, linkedAttemptId }: { initial: StudyEnrollmentContext; search: string; linkedAttemptId?: string }) {
  const router = useRouter();
  const prefix = useId();
  const formId = `${prefix}-enrollment`;
  const [loadedInitial, setLoadedInitial] = useState(initial);
  const [current, setCurrent] = useState(initial);
  const [groupId, setGroupId] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<StudyEnrollmentContext["groups"][number] | null>(null);
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
  const [openNoteId, setOpenNoteId] = useState<string | null>(null);
  const [pendingNoteId, setPendingNoteId] = useState<string | null>(null);
  const [noteDirty, setNoteDirty] = useState(false);
  const [repeatId, setRepeatId] = useState<string | null>(null);
  const [openWithdrawalId, setOpenWithdrawalId] = useState<string | null>(null);
  const [withdrawalDirty, setWithdrawalDirty] = useState(false);
  const [openWaitlistId, setOpenWaitlistId] = useState<string | null>(null);
  const [waitlistDirty, setWaitlistDirty] = useState(false);
  const waitlistOpener = useRef<string | null>(null);
  const repeatOpener = useRef<string | null>(null);
  const withdrawalOpener = useRef<string | null>(null);
  const noteOpener = useRef<string | null>(null);
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  if (loadedInitial !== initial) {
    setLoadedInitial(initial); setCurrent(initial);
    if (current.student.id !== initial.student.id) {
      setGroupId(""); setSelectedGroup(null); setJoinedOn(""); setDiscount("0.00"); setReason(""); setRepeatId(null); setOpenWithdrawalId(null); setOpenWaitlistId(null);
    }
  }
  const studentId = current.student.id;
  const selected = current.groups.find(group => group.id === groupId) ?? (selectedGroup?.id === groupId ? selectedGroup : undefined);
  const discountAllowed = Boolean(selected && (current.permissions.can_manage_center ||
    current.permissions.branch_actions?.[String(selected.branch_id)]?.includes("fees.discount")));
  const registrationDirty = Boolean(groupId || joinedOn || discount !== "0.00" || reason || repeatId);
  const dirty = registrationDirty || noteDirty || withdrawalDirty || waitlistDirty;
  const path = `/admin/students/${studentId}/enrollments`;
  const query = new URLSearchParams({ page: String(current.pagination.page), groups_page: String(current.pagination.groups_page), ...(search ? { q: search } : {}), ...(linkedAttemptId ? { attempt_id: linkedAttemptId } : {}) });
  const endpoint = `students/${studentId}/enrollments?${query}`;
  const focus = (field: string) => requestAnimationFrame(() => document.getElementById(`${prefix}-${field}`)?.focus());

  function reset(restoreRepeatFocus = false) {
    const opener = restoreRepeatFocus && repeatId ? repeatOpener.current : null;
    setGroupId(""); setSelectedGroup(null); setJoinedOn(""); setDiscount("0.00"); setReason(""); setRepeatId(null);
    setFieldErrors({}); setError(""); setConflict(false); setUncertain(false); requestId.current = null;
    requestAnimationFrame(() => (opener && document.getElementById(opener) ? document.getElementById(opener) : document.getElementById(`${prefix}-group_id`))?.focus());
  }

  function closeNote() {
    setOpenNoteId(null); setNoteDirty(false);
    requestAnimationFrame(() => { if (noteOpener.current) document.getElementById(noteOpener.current)?.focus(); });
  }

  function closeWithdrawal() {
    setOpenWithdrawalId(null); setWithdrawalDirty(false);
    requestAnimationFrame(() => { if (withdrawalOpener.current) document.getElementById(withdrawalOpener.current)?.focus(); });
  }

  function closeWaitlist() {
    setOpenWaitlistId(null); setWaitlistDirty(false);
    requestAnimationFrame(() => { if (waitlistOpener.current) document.getElementById(waitlistOpener.current)?.focus(); });
  }

  function discard() { reset(); closeNote(); closeWithdrawal(); closeWaitlist(); }

  function openNote(attemptId: string) {
    if (openNoteId === attemptId) return;
    if (noteDirty) { setPendingNoteId(attemptId); return; }
    setOpenNoteId(attemptId);
  }

  function noteSaved(attemptId: string, note: StudyAttemptNote) {
    setCurrent(previous => ({ ...previous, attempts: previous.attempts.map(attempt =>
      attempt.id === attemptId ? { ...attempt, note } : attempt) }));
  }

  async function reload() {
    if (submitting.current) return;
    setBusy(true);
    try {
      const response = await centerRequest(endpoint, "GET");
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const fresh = await response.json() as StudyEnrollmentContext;
      setCurrent(fresh); setConflict(false); setUncertain(false); requestId.current = null;
      if (!fresh.groups.some(group => group.id === groupId)) { setGroupId(""); setSelectedGroup(null); }
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
    const repeatSource = current.attempts.find(attempt => attempt.id === repeatId);
    if (repeatId && selected && repeatSource && selected.level_id !== repeatSource.level_id) errors.group_id = "اختر مجموعة في مستوى المحاولة السابقة.";
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
        repeated_from_attempt_id: repeatId,
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
      reset(); setNotice(repeatId ? "أُنشئت محاولة إعادة الدراسة برسومها وخطتها المستقلتين. بقيت المحاولة السابقة محفوظة." : "سُجلت المحاولة ورسومها معًا. بقي الرصيد المقدم دون تخصيص.");
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
    if (dirty && !repeatId) { setPendingSearch(href); return; }
    router.push(href);
  }

  return <>
    <CenterPageActions context={current} />
    <UnsavedChangesGuard dirty={dirty} guardHistory onDiscard={discard} />
    {pendingSearch ? <ConfirmationDialog title="مغادرة دون حفظ" description="لديك بيانات تسجيل لم تُحفظ. هل تريد مسحها والبحث عن مجموعات أخرى؟" confirmLabel="مسح البيانات والبحث" onCancel={() => setPendingSearch(null)} onConfirm={() => {
      discard(); router.push(pendingSearch); setPendingSearch(null);
    }} /> : null}
    {pendingNoteId ? <ConfirmationDialog title="تغيير الملاحظة دون حفظ" description="لديك تعديل ملاحظة لم يُحفظ. هل تريد مسحه وفتح ملاحظة تسجيل أخرى؟" confirmLabel="مسح التعديل وفتح الأخرى" onCancel={() => setPendingNoteId(null)} onConfirm={() => {
      setOpenNoteId(pendingNoteId); setNoteDirty(false); setPendingNoteId(null);
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
      <h2 id={`${prefix}-title`}>{repeatId ? "إعادة الدراسة بمحاولة جديدة" : "تسجيل محاولة دراسة"}</h2>
      <p className="muted">يثبت سعر المجموعة وخطتها عند التسجيل، حتى لو تغير السعر لاحقًا. تاريخ الانضمام لا يسقط محاضرات الخطة السابقة.</p>
      {repeatId ? <InlineNotice>سيُنشأ تسجيل ورسوم مستقلان للمحاولة الجديدة. تظل المحاولة السابقة وحضورها ومديونيتها محفوظة. اختر مجموعة في المستوى نفسه.</InlineNotice> : null}
      <form id={formId} onSubmit={save} noValidate><FieldGroup>
        <Field data-invalid={Boolean(fieldErrors.group_id)}>
          <FieldLabel htmlFor={`${prefix}-group_id`}>المجموعة الأساسية</FieldLabel>
          <NativeSelect id={`${prefix}-group_id`} value={groupId} onChange={event => {
            setGroupId(event.target.value); setSelectedGroup(current.groups.find(group => group.id === event.target.value) ?? null); setFieldErrors({});
          }} aria-invalid={Boolean(fieldErrors.group_id)}>
            <NativeSelectOption value="">اختر مجموعة</NativeSelectOption>
            {current.groups.map(group => <NativeSelectOption key={group.id} value={group.id}>{group.branch_name} — {group.level_name} — {group.name} ({group.approved_price} {current.student.currency ?? ""})</NativeSelectOption>)}
            {selectedGroup && !current.groups.some(group => group.id === selectedGroup.id) ? <NativeSelectOption value={selectedGroup.id}>
              {selectedGroup.branch_name} — {selectedGroup.level_name} — {selectedGroup.name} ({selectedGroup.approved_price} {current.student.currency ?? ""})
            </NativeSelectOption> : null}
          </NativeSelect>
          {fieldErrors.group_id ? <FieldError id={`${prefix}-group_id-error`}>{fieldErrors.group_id}</FieldError> : null}
        </Field>
        <FormField id={`${prefix}-joined_on`} label="تاريخ الانضمام الفعلي" type="date" value={joinedOn} onChange={value => { setJoinedOn(value); setFieldErrors({}); }} error={fieldErrors.joined_on} />
        <FormField id={`${prefix}-discount`} label="الخصم" type="text" direction="ltr" value={discount} onChange={value => { setDiscount(value); setFieldErrors({}); }} error={fieldErrors.discount} disabled={!discountAllowed} hint={discountAllowed ? "يمكن خصم السعر كاملًا مع سبب مسجل." : "يتطلب صلاحية خصم مستقلة في فرع المجموعة."} />
        {discountAllowed && Number(discount) > 0 ? <FormField id={`${prefix}-discount_reason`} label="سبب الخصم" value={reason} onChange={value => { setReason(value); setFieldErrors({}); }} error={fieldErrors.discount_reason} /> : null}
      </FieldGroup></form>
      {selected ? <p>السعر الأصلي <bdi dir="ltr">{selected.approved_price}</bdi> — الصافي بعد الخصم <strong><bdi dir="ltr">{Math.max(0, Number(selected.approved_price) - (Number(discount) || 0)).toFixed(2)} {current.student.currency ?? ""}</bdi></strong></p> : null}
      <CenterHeaderActions>
        <Button form={formId} type="submit" variant="primary" busy={busy} disabled={conflict || !current.student.currency || current.student.status !== "active"}>{uncertain ? "التحقق من التسجيل" : repeatId ? "إعادة الدراسة وتسجيل الرسوم" : "تسجيل الطالب والرسوم"}</Button>
        <Button disabled={busy || uncertain || !registrationDirty} onClick={() => reset(true)}>إلغاء البيانات</Button>
      </CenterHeaderActions>
    </section>
    <DataTable id="enrollment-group-choices" title="المجموعات المتاحة للتسجيل" rows={current.groups} rowKey={row => row.id}
      serverPagination={{ page: current.pagination.groups_page, hasMore: current.pagination.groups_has_more, batchSize: 50,
        previousHref: groupsPage(current.pagination.groups_page - 1),
        nextHref: groupsPage(current.pagination.groups_page + 1),
        ...(repeatId ? { onNavigate: (href: string) => router.push(href) } : {}) }}
      serverSearch={{ value: search, onSearch: searchGroups }}
      searchText={row => `${row.name} ${row.level_name} ${row.branch_name}`}
      emptyMessage="لا توجد مجموعات في فروع تسجيل الطالب ضمن هذه الدفعة." description="ابحث باسم المجموعة، ثم اخترها في نموذج التسجيل. تظهر حتى ٥٠ مجموعة في الدفعة."
      columns={[
        { key: "name", label: "المجموعة", render: row => row.name },
        { key: "level", label: "المستوى", render: row => row.level_name },
        { key: "branch", label: "الفرع", render: row => row.branch_name },
        { key: "price", label: "السعر المعتمد", render: row => <bdi dir="ltr">{row.approved_price} {current.student.currency ?? ""}</bdi> },
      ]} />
    {linkedAttemptId ? <p>المحاولة المرتبطة بالملاحظة: <PrefetchLink href={path}>عرض كل المحاولات</PrefetchLink></p> : null}
    <DataTable id="student-attempts" title="محاولات الدراسة" rows={current.attempts} rowKey={row => row.id}
      serverPagination={{ page: current.pagination.page, hasMore: current.pagination.has_more, batchSize: 20,
        previousHref: page(current.pagination.page - 1),
        nextHref: page(current.pagination.page + 1) }}
      searchText={row => `${row.group_name ?? "انتظار المستوى"} ${row.level_name} ${row.fee.net_amount}`}
      emptyMessage="لا توجد محاولات دراسة في فروع صلاحيتك." description="آخر ٢٠ محاولة في الدفعة الحالية. الرسوم المعتمدة محفوظة مع سبب الخصم والموظف."
      columns={[
        { key: "group", label: "المجموعة / المستوى", render: row => `${row.group_name ?? "انتظار المستوى"} — ${row.level_name}` },
        { key: "joined", label: "الانضمام", render: row => <bdi dir="ltr">{row.joined_on}</bdi> },
        { key: "status", label: "الحالة", render: row => <span>{row.status === "active" ? row.current_group_id ? "نشطة" : `انتظار منذ ${row.latest_waitlist?.entered_on ?? "—"}` : row.status === "withdrawn" ? `انسحب في ${row.withdrawal?.withdrawn_on ?? "—"}` : "مكتملة"}{row.repeated_from_attempt_id ? " — إعادة دراسة" : ""}{row.withdrawal ? <small className="muted"> — {row.withdrawal.reason} ({row.withdrawal.actor_name})</small> : null}</span> },
        { key: "requirements", label: "متطلبات الخطة", render: row => row.requirements_count.toLocaleString("ar-EG") },
        { key: "fee", label: "الرسوم بعد الخصم", render: row => <bdi dir="ltr">{row.fee.net_amount} {row.fee.currency}</bdi> },
        { key: "actor", label: "سجلها", render: row => row.fee.actor_name },
        { key: "note", label: "ملاحظة التسجيل", render: row => row.note ? <span>{row.note.important ? "★ " : ""}{row.note.body.slice(0, 80)}{row.note.body.length > 80 ? "…" : ""}</span> : "—" },
        { key: "actions", label: "الإجراءات", actions: true, render: row => {
          const canManageAttempt = current.permissions.can_manage_center ||
            current.permissions.branch_actions?.[String(row.branch_id)]?.includes("enrollment.manage");
          const canManageNote = current.permissions.can_manage_center ||
            current.permissions.branch_actions?.[String(row.event_branch_id)]?.includes("enrollment.manage");
          if ((!canManageAttempt || (row.status !== "active" && row.has_repeat)) && !canManageNote) return <span className="muted">غير متاح</span>;
          return <div className="form-actions">
            {canManageAttempt && row.status === "active" ? <Button id={`${prefix}-waitlist-${row.id}`} type="button" disabled={busy || dirty} onClick={event => {
              waitlistOpener.current = event.currentTarget.id; setOpenWaitlistId(row.id);
            }}>{row.current_group_id ? "نقل إلى الانتظار" : "إعادة الإلحاق"}</Button> : null}
            {canManageAttempt && row.status === "active" ? <Button id={`${prefix}-withdraw-${row.id}`} type="button" disabled={busy || dirty} onClick={event => {
              withdrawalOpener.current = event.currentTarget.id; setOpenWithdrawalId(row.id);
            }}>انسحاب</Button> : null}
            {canManageAttempt && row.status !== "active" && !row.has_repeat ? <Button id={`${prefix}-repeat-${row.id}`} type="button" disabled={busy || dirty} onClick={event => {
              repeatOpener.current = event.currentTarget.id;
              setRepeatId(row.id); setGroupId(""); setSelectedGroup(null); setJoinedOn(""); setDiscount("0.00"); setReason("");
              focus("group_id");
            }}>إعادة الدراسة</Button> : null}
            {canManageNote ? <Button id={`${prefix}-note-${row.id}`} type="button" onClick={event => { noteOpener.current = event.currentTarget.id; openNote(row.id); }}>{row.note ? "عرض/تعديل الملاحظة" : "إضافة ملاحظة"}</Button> : null}
          </div>;
        } },
      ]} />
    {openNoteId && current.attempts.find(attempt => attempt.id === openNoteId) ? <section className="context-card" aria-label="محرر ملاحظة التسجيل">
      <StudyAttemptNoteEditor key={openNoteId} studentId={studentId} attempt={current.attempts.find(attempt => attempt.id === openNoteId)!}
        onClose={closeNote} onSaved={note => noteSaved(openNoteId, note)} onDirtyChange={setNoteDirty} />
    </section> : null}
    {openWithdrawalId && current.attempts.find(attempt => attempt.id === openWithdrawalId) ?
      <StudyWithdrawalEditor key={openWithdrawalId} studentId={studentId} attempt={current.attempts.find(attempt => attempt.id === openWithdrawalId)!}
        onClose={closeWithdrawal} onDirtyChange={setWithdrawalDirty} onSaved={updated => {
          setCurrent(previous => ({ ...previous, attempts: previous.attempts.map(attempt => attempt.id === updated.id ? updated : attempt) }));
          setNotice("حُفظ الانسحاب. الرسوم والدفعات والمديونية لم تتغير؛ التسوية المالية إجراء مستقل.");
        }} /> : null}
    {openWaitlistId && current.attempts.find(attempt => attempt.id === openWaitlistId) ?
      <StudyWaitlistEditor key={openWaitlistId} studentId={studentId} attempt={current.attempts.find(attempt => attempt.id === openWaitlistId)!}
        onClose={closeWaitlist} onDirtyChange={setWaitlistDirty} onSaved={() => { void reload(); setNotice("حُفظ قرار الانتظار أو الإلحاق دون رسوم أو تخصيص جديد."); }} /> : null}
  </>;
}
