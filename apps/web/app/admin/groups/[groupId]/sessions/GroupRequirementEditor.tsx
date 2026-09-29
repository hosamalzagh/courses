"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { DataTable } from "@/components/DataTable";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { centerRequest, newSubmissionId, responseFieldErrors, responseMessage } from "@/lib/client-api";
import type { SessionContext, StudySession } from "@/lib/groups";
import { formatSessionTime } from "@/lib/session-time";

type Mode = { kind: "add" } | { kind: "reduce"; session: StudySession };
type StudentImpact = { attempt_id: string; name: string; student_number: number; covered_count: number;
  before_percentage: number; after_percentage: number; before_needed: number; after_needed: number;
  before_eligible: boolean; after_eligible: boolean; before_provisional: boolean; after_provisional: boolean;
  before_open_count: number; after_open_count: number };
type Preview = { group_revision: number; before: { required_count: number }; after: { required_count: number; last_number: number };
  session: { id: string; status: string } | null; students: StudentImpact[];
  affected_total: number; pagination: { page: number; has_more: boolean; total: number }; preview_token: string };

export function GroupRequirementEditor({ group, mode, onSaved, onReload, onClose }: {
  group: SessionContext["group"]; mode: Mode;
  onSaved: (kind: Mode["kind"]) => Promise<void>; onReload: () => Promise<void>; onClose: () => void;
}) {
  const formId = useId();
  const busyRef = useRef(false);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState<"financial" | "none">(
    mode.kind === "reduce" && mode.session.compensation_decision === "financial" ? "financial" : "none",
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [requestId, setRequestId] = useState(newSubmissionId);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");

  function resetPreview() {
    setPreview(null); setRequestId(newSubmissionId()); setError(""); setFieldErrors({});
  }
  function body() {
    return mode.kind === "add"
      ? { kind: "add", content: content.trim(), title: title.trim() || null, reason: reason.trim() }
      : { kind: "reduce", session_id: mode.session.id, decision, reason: reason.trim() };
  }
  function showValidation(errors: Record<string, string>) {
    setFieldErrors(errors);
    const first = Object.keys(errors)[0];
    if (first) requestAnimationFrame(() => document.getElementById(`${formId}-${first}`)?.focus());
  }
  const eligibility = (eligible: boolean, provisional: boolean, openCount: number) =>
    `${eligible ? provisional ? "مؤهل مبدئيًا" : "مؤهل" : "غير مؤهل"}${openCount > 0
      ? ` · ${openCount.toLocaleString("ar-EG")} محاضرة مفتوحة؛ احتسابها مبدئي حتى الإغلاق` : ""}`;
  async function review(page = 1, query = search) {
    if (busyRef.current || reason.trim().length < 3 || (mode.kind === "add" && !content.trim())) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const response = await centerRequest(`groups/${group.id}/requirements/preview`, "POST", { ...body(), page, q: query });
      if (!response.ok) {
        if (response.status === 409) setConflict(true);
        if (response.status === 422) showValidation(await responseFieldErrors(response));
        setError(await responseMessage(response)); return;
      }
      const result = (await response.json()) as Preview;
      setSearch(query);
      setPreview(current => page > 1 && current && current.preview_token === result.preview_token
        ? { ...result, students: [...current.students, ...result.students] } : result);
      if (page === 1) requestAnimationFrame(() => document.getElementById(`${formId}-preview`)?.focus());
    } catch { setError("تعذرت معاينة أثر القرار. حاول مرة أخرى."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function confirm() {
    if (busyRef.current || !preview) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const response = await centerRequest(`groups/${group.id}/requirements`, "POST", {
        ...body(), group_revision: preview.group_revision,
        preview_token: preview.preview_token, request_id: requestId,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setPreview(null); }
        if (response.status === 422) showValidation(await responseFieldErrors(response));
        setError(await responseMessage(response)); return;
      }
      await onSaved(mode.kind);
    } catch { setError("تعذر التأكد من اعتماد القرار. أعد تأكيد الطلب نفسه؛ لن يتكرر التغيير."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <form id={`${formId}-form`} noValidate className="context-card form-stack" aria-label={mode.kind === "add" ? "اعتماد محاضرة إضافية" : "اعتماد خفض عدد المحاضرات"}
    onSubmit={event => { event.preventDefault(); if (preview) void confirm(); else void review(); }}>
    <h2>{mode.kind === "add" ? "اعتماد محاضرة كاملة إضافية" : `إلغاء نهائي وخفض العدد · الموعد ${mode.session.number.toLocaleString("ar-EG")}`}</h2>
    {mode.kind === "reduce" ? <p>محاضرة الخطة {mode.session.plan_lecture_number.toLocaleString("ar-EG")} · الموعد الأصلي {formatSessionTime(mode.session.scheduled_at)}. خفض العدد يتطلب معاينة واعتمادًا مستقلًا، ولا يحدث عند الإلغاء وحده.</p>
      : <p>ستضاف محاضرة مرقمة للمجموعة الحالية فقط؛ تبقى الخطة والمجموعات الأخرى كما هي.</p>}
    {mode.kind === "add" ? <>
      <FormField id={`${formId}-content`} label="محتوى المحاضرة الإضافية" value={content} onChange={value => { setContent(value); resetPreview(); }} error={fieldErrors.content} disabled={busy || conflict} required focusOnMount />
      <FormField id={`${formId}-title`} label="عنوان المحاضرة (اختياري)" value={title} onChange={value => { setTitle(value); resetPreview(); }} error={fieldErrors.title} disabled={busy || conflict} />
    </> : <Field data-invalid={Boolean(fieldErrors.decision)}>
      <FieldLabel htmlFor={`${formId}-decision`}>قرار التعويض</FieldLabel>
      <NativeSelect id={`${formId}-decision`} value={decision} disabled={busy || conflict || (Boolean(mode.session.cancelled_at) && mode.session.compensation_decision !== "academic")} onChange={event => { setDecision(event.target.value as typeof decision); resetPreview(); }}>
        <NativeSelectOption value="none">دون تعويض</NativeSelectOption>
        <NativeSelectOption value="financial">مراجعة مالية مستقلة</NativeSelectOption>
      </NativeSelect>
      <FieldDescription>يسجل القرار دون حركة مالية أو حضور تلقائي. يمكن إنهاء قرار البديل الأكاديمي السابق إذا لم يُحجز بديل، وتبقى القرارات الأخرى كما حُفظت.</FieldDescription>
      {fieldErrors.decision ? <FieldError>{fieldErrors.decision}</FieldError> : null}
    </Field>}
    <FormField id={`${formId}-reason`} label="سبب تغيير العدد المعتمد" value={reason} onChange={value => { setReason(value); resetPreview(); }} error={fieldErrors.reason} disabled={busy || conflict} required focusOnMount={mode.kind === "reduce"} />
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {preview ? <section className="form-stack" aria-labelledby={`${formId}-preview`}>
      <h3 id={`${formId}-preview`} tabIndex={-1}>أثر القرار قبل الاعتماد</h3>
      <p>المحاضرات المعتمدة: {preview.before.required_count.toLocaleString("ar-EG")} ← {preview.after.required_count.toLocaleString("ar-EG")}. {mode.kind === "add" ? `رقم المحاضرة الجديدة ${preview.after.last_number.toLocaleString("ar-EG")}.` : preview.session?.status === "cancelled" ? "الموعد ملغى مسبقًا؛ سيُخفض العدد بعد الاعتماد." : "سيُلغى الموعد وتُخفض المتطلبات معًا عند التأكيد."}</p>
      <p>الطلاب المتأثرون: {preview.affected_total.toLocaleString("ar-EG")}{search ? ` · المطابقون للبحث: ${preview.pagination.total.toLocaleString("ar-EG")}` : ""}. النسب محسوبة من محاضرات كاملة، وحد الاستيفاء لكل طالب محفوظ من تسجيله.</p>
      <DataTable id="requirement-impact" title="أثر القرار على الطلاب" rows={preview.students} rowKey={row => row.attempt_id}
        searchText={row => `${row.name} ${row.student_number}`} emptyMessage="لا توجد تسجيلات مطابقة."
        serverSearch={{ value: search, onSearch: value => void review(1, value) }}
        columns={[
          { key: "name", label: "الطالب", render: row => `${row.student_number.toLocaleString("ar-EG")} · ${row.name}` },
          { key: "covered", label: "المحتسب", render: row => row.covered_count.toLocaleString("ar-EG") },
          { key: "before", label: "قبل", render: row => `${row.before_percentage.toLocaleString("ar-EG")}% · ${row.before_needed.toLocaleString("ar-EG")} مطلوبة · ${eligibility(row.before_eligible, row.before_provisional, row.before_open_count)}` },
          { key: "after", label: "بعد", render: row => `${row.after_percentage.toLocaleString("ar-EG")}% · ${row.after_needed.toLocaleString("ar-EG")} مطلوبة · ${eligibility(row.after_eligible, row.after_provisional, row.after_open_count)}` },
        ]} />
    </section> : null}
    <CenterHeaderActions>
      {conflict ? <Button disabled={busy} onClick={() => void onReload().then(() => { setConflict(false); setPreview(null); setLoaded(true); }).catch(() => setError("تعذر تحميل أحدث البيانات."))}>تحميل أحدث البيانات</Button> : null}
      <Button form={`${formId}-form`} type="submit" variant="primary" busy={busy} disabled={conflict || reason.trim().length < 3 || (mode.kind === "add" && !content.trim())}>{preview ? "تأكيد اعتماد القرار" : "معاينة الأثر"}</Button>
      {preview?.pagination.has_more ? <Button disabled={busy} onClick={() => void review(preview.pagination.page + 1)}>عرض المزيد من الطلاب</Button> : null}
      <Button disabled={busy} onClick={onClose}>رجوع</Button>
    </CenterHeaderActions>
    {loaded ? <p role="status">حُمّلت أحدث بيانات المجموعة. راجع القرار وأعد المعاينة.</p> : null}
  </form>;
}
