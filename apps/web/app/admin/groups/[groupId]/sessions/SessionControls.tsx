"use client";

import { useSearchParams } from "next/navigation";
import { curriculumExplorerHref } from "@/lib/curriculum-explorer";
import { useId, useRef, useState } from "react";
import { useWorkspaceRouter as useRouter } from "@/components/WorkspaceNavigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions, CenterPageActions } from "@/components/CenterShell";
import { DataTable } from "@/components/DataTable";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { levelGroupsHref } from "@/lib/curriculum-navigation";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { centerRequest, newSubmissionId, responseFieldErrors, responseMessage } from "@/lib/client-api";
import type { SessionContext, StudySession } from "@/lib/groups";
import { formatSessionTime, parseSessionTime } from "@/lib/session-time";
import { GroupRequirementEditor } from "./GroupRequirementEditor";
import { GroupRequirementEquivalenceEditor } from "./GroupRequirementEquivalenceEditor";

type Draft = { kind: "single" | "weekly"; start_at: string; count: string; interval_weeks: string; plan_lecture_number: string; title: string };
type Preview = { group_revision: number; sessions: { number: number; plan_lecture_number: number; title: string | null; local_at: string }[] };
type CancelPreview = { group_revision: number; session_revision: number; plan_lecture_number: number; required_count: number; scheduled_at: string; preview_token: string };
type ReplacementPreview = { group_revision: number; session_revision: number; number: number; plan_lecture_number: number; local_at: string; title: string | null; preview_token: string };
const initialDraft: Draft = { kind: "single", start_at: "", count: "1", interval_weeks: "1", plan_lecture_number: "", title: "" };

export function SessionControls({ context, explorer = false }: { context: SessionContext; explorer?: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  function pageHref(page: number) { const next = new URLSearchParams(params.toString()); if (page > 1) next.set("sessions_page", String(page)); else next.delete("sessions_page"); return `/admin/curriculum?${next}`; }
  const formId = useId();
  const busyRef = useRef(false);
  const [group, setGroup] = useState(context.group);
  const [sessions, setSessions] = useState(context.sessions);
  const [loadedContext, setLoadedContext] = useState(context);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [requestId, setRequestId] = useState(newSubmissionId);
  const [selected, setSelected] = useState<StudySession | null>(null);
  const [postponeAt, setPostponeAt] = useState("");
  const [reason, setReason] = useState("");
  const [postponeId, setPostponeId] = useState(newSubmissionId);
  const [cancelTarget, setCancelTarget] = useState<StudySession | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelDecision, setCancelDecision] = useState<"academic" | "financial" | "none">("academic");
  const [cancelPreview, setCancelPreview] = useState<CancelPreview | null>(null);
  const [cancelId, setCancelId] = useState(newSubmissionId);
  const [replacementTarget, setReplacementTarget] = useState<StudySession | null>(null);
  const [replacementAt, setReplacementAt] = useState("");
  const [replacementTitle, setReplacementTitle] = useState("");
  const [replacementPreview, setReplacementPreview] = useState<ReplacementPreview | null>(null);
  const [replacementId, setReplacementId] = useState(newSubmissionId);
  const [requirementEditor, setRequirementEditor] = useState<{ kind: "add" } | { kind: "reduce"; session: StudySession } | null>(null);
  const [equivalenceEditor, setEquivalenceEditor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  if (loadedContext !== context) {
    setLoadedContext(context);
    setGroup(context.group);
    setSessions(context.sessions);
    setSelected(previous => previous ? context.sessions.find(item => item.id === previous.id) ?? null : null);
    setCancelTarget(previous => previous ? context.sessions.find(item => item.id === previous.id) ?? null : null);
    setReplacementTarget(previous => previous ? context.sessions.find(item => item.id === previous.id) ?? null : null);
    setPreview(null);
    setCancelPreview(null); setReplacementPreview(null);
    setConflict(false);
  }
  const dirty = Boolean(preview || JSON.stringify(draft) !== JSON.stringify(initialDraft) || selected || postponeAt || reason || cancelTarget || replacementTarget || requirementEditor || equivalenceEditor);
  const prefix = `groups/${group.id}/sessions`;
  const available = group.requirements.filter(requirement => !group.scheduled_requirements.includes(requirement.number));

  function changeDraft(change: Partial<Draft>) {
    setDraft(current => ({ ...current, ...change }));
    setPreview(null); setRequestId(newSubmissionId()); setError(""); setFieldErrors({});
  }

  function showValidation(errors: Record<string, string>) {
    setFieldErrors(errors);
    const key = Object.keys(errors)[0];
    const input = key === "start_at" && replacementTarget ? "replacement-at"
      : key === "title" && replacementTarget ? "replacement-title"
        : key === "reason" && cancelTarget ? "cancel-reason"
          : ({ start_at: "start", plan_lecture_number: "requirement", count: "count", interval_weeks: "interval",
            title: "title", scheduled_at: "postpone", reason: "reason", decision: "cancel-decision" } as Record<string, string>)[key];
    if (input) requestAnimationFrame(() => document.getElementById(`${formId}-${input}`)?.focus());
  }

  function scheduleBody() {
    return { kind: draft.kind, revision: group.revision, start_at: draft.start_at,
      ...(draft.kind === "weekly" ? { count: Number(draft.count), interval_weeks: Number(draft.interval_weeks) }
        : { plan_lecture_number: Number(draft.plan_lecture_number), title: draft.title.trim() || null }) };
  }

  async function reload() {
    const response = await centerRequest(`${prefix}?page=${context.pagination.page}`, "GET");
    if (!response.ok) throw new Error(await responseMessage(response));
    const current = (await response.json()) as SessionContext;
    setGroup(current.group); setSessions(current.sessions);
    setPreview(null);
    setSelected(previous => previous ? current.sessions.find(item => item.id === previous.id) ?? null : null);
    setCancelTarget(previous => previous ? current.sessions.find(item => item.id === previous.id) ?? null : null);
    setReplacementTarget(previous => previous ? current.sessions.find(item => item.id === previous.id) ?? null : null);
    setCancelPreview(null); setReplacementPreview(null);
    setConflict(false);
    router.refresh();
  }

  async function review() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`${prefix}/preview`, "POST", scheduleBody());
      if (!response.ok) {
        if (response.status === 409) setConflict(true);
        if (response.status === 422) showValidation(await responseFieldErrors(response));
        setError(await responseMessage(response)); return;
      }
      setPreview((await response.json()) as Preview);
      requestAnimationFrame(() => document.getElementById(`${formId}-preview`)?.focus());
    } catch { setError("تعذر معاينة المواعيد. حاول مرة أخرى."); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function confirm() {
    if (busyRef.current || !preview || preview.group_revision !== group.revision) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(prefix, "POST", { ...scheduleBody(), request_id: requestId });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setPreview(null); }
        if (response.status === 422) showValidation(await responseFieldErrors(response));
        setError(await responseMessage(response)); return;
      }
      const result = (await response.json()) as { sessions: StudySession[]; group_revision?: number };
      setSessions(current => [...current, ...result.sessions.filter(item => !current.some(existing => existing.id === item.id))]);
      setGroup(current => ({ ...current, revision: result.group_revision ?? current.revision,
        scheduled_requirements: [...new Set([...current.scheduled_requirements, ...result.sessions.map(item => item.plan_lecture_number)])] }));
      setDraft(initialDraft); setPreview(null); setRequestId(newSubmissionId());
      setNotice("حُفظت المواعيد وربطت بالمحاضرات المعتمدة للمجموعة.");
      router.refresh();
    } catch { setError("تعذر التأكد من الحفظ. أعد التأكيد بنفس الطلب؛ لن تتكرر المحاضرات."); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function postpone() {
    if (busyRef.current || !selected) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`${prefix}/${selected.id}/postpone`, "PATCH", {
        revision: selected.revision, scheduled_at: postponeAt, reason: reason.trim() || null, request_id: postponeId,
      });
      if (!response.ok) {
        if (response.status === 409) setConflict(true);
        if (response.status === 422) showValidation(await responseFieldErrors(response));
        setError(await responseMessage(response)); return;
      }
      const result = (await response.json()) as { session: StudySession; group_revision?: number };
      setSessions(current => current.map(item => item.id === result.session.id ? result.session : item));
      if (result.group_revision) setGroup(current => ({ ...current, revision: result.group_revision! }));
      const id = selected.id;
      setSelected(null); setPostponeAt(""); setReason(""); setPostponeId(newSubmissionId());
      setNotice("تأجل موعد المحاضرة؛ بقي رقمها والمحاضرة المعتمدة المرتبطة بها كما هما.");
      router.refresh();
      requestAnimationFrame(() => document.getElementById(`postpone-${id}`)?.focus());
    } catch { setError("تعذر التأكد من التأجيل. أعد الطلب نفسه للتحقق من النتيجة."); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function reviewCancellation() {
    if (busyRef.current || !cancelTarget || cancelReason.trim().length < 3) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`${prefix}/${cancelTarget.id}/cancel-preview`, "GET");
      if (!response.ok) { if (response.status === 409) setConflict(true); setError(await responseMessage(response)); return; }
      setCancelPreview((await response.json()) as CancelPreview);
      requestAnimationFrame(() => document.getElementById(`${formId}-cancel-preview`)?.focus());
    } catch { setError("تعذرت معاينة الإلغاء. حاول مرة أخرى."); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function confirmCancellation() {
    if (busyRef.current || !cancelTarget || !cancelPreview) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`${prefix}/${cancelTarget.id}/cancel`, "POST", {
        reason: cancelReason.trim(), decision: cancelDecision, group_revision: cancelPreview.group_revision,
        session_revision: cancelPreview.session_revision, preview_token: cancelPreview.preview_token, request_id: cancelId,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setCancelPreview(null); }
        if (response.status === 422) showValidation(await responseFieldErrors(response));
        setError(await responseMessage(response)); return;
      }
      const result = (await response.json()) as { session: StudySession; group_revision: number };
      setSessions(current => current.map(item => item.id === result.session.id ? result.session : item));
      setGroup(current => ({ ...current, revision: result.group_revision }));
      const id = cancelTarget.id;
      setCancelTarget(null); setCancelPreview(null); setCancelReason(""); setCancelId(newSubmissionId());
      setNotice("أُلغي الموعد وبقي متطلب المحاضرة في العدد المعتمد. لم يُسجل غياب أو إجراء مالي تلقائي.");
      router.refresh(); requestAnimationFrame(() => document.getElementById(`cancel-${id}`)?.focus());
    } catch { setError("تعذر التأكد من الإلغاء. أعد تأكيد الطلب نفسه؛ لن يتكرر الأثر."); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function reviewReplacement() {
    if (busyRef.current || !replacementTarget || !replacementAt) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`${prefix}/${replacementTarget.id}/replacement-preview`, "POST", {
        start_at: replacementAt, title: replacementTitle.trim() || null,
      });
      if (!response.ok) {
        if (response.status === 409) setConflict(true);
        if (response.status === 422) showValidation(await responseFieldErrors(response));
        setError(await responseMessage(response)); return;
      }
      setReplacementPreview((await response.json()) as ReplacementPreview);
      requestAnimationFrame(() => document.getElementById(`${formId}-replacement-preview`)?.focus());
    } catch { setError("تعذرت معاينة الموعد البديل. حاول مرة أخرى."); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function confirmReplacement() {
    if (busyRef.current || !replacementTarget || !replacementPreview) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`${prefix}/${replacementTarget.id}/replacement`, "POST", {
        start_at: replacementAt, title: replacementTitle.trim() || null,
        group_revision: replacementPreview.group_revision, session_revision: replacementPreview.session_revision,
        preview_token: replacementPreview.preview_token, request_id: replacementId,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setReplacementPreview(null); }
        if (response.status === 422) showValidation(await responseFieldErrors(response));
        setError(await responseMessage(response)); return;
      }
      const result = (await response.json()) as { session: StudySession; group_revision: number };
      setSessions(current => [...current.map(item => item.id === replacementTarget.id ? { ...item, replacement_id: result.session.id, replacement_number: result.session.number } : item), result.session]);
      setGroup(current => ({ ...current, revision: result.group_revision }));
      setReplacementTarget(null); setReplacementPreview(null); setReplacementAt(""); setReplacementTitle(""); setReplacementId(newSubmissionId());
      setNotice("حُفظ الموعد البديل وربط بالمحاضرة المعتمدة نفسها دون زيادة العدد المعتمد.");
      router.refresh(); requestAnimationFrame(() => document.getElementById(`${formId}-heading`)?.focus());
    } catch { setError("تعذر التأكد من حفظ البديل. أعد تأكيد الطلب نفسه؛ لن يتكرر الموعد."); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function requirementSaved(kind: "add" | "reduce") {
    await reload();
    setRequirementEditor(null);
    setNotice(kind === "add" ? "اعتمدت محاضرة كاملة إضافية لهذه المجموعة، مع حفظ أثرها على نسب الطلاب."
      : "اعتمد خفض عدد المحاضرات بعد معاينة أثر الإلغاء النهائي، دون حضور أو حركة مالية تلقائية.");
    requestAnimationFrame(() => document.getElementById(`${formId}-heading`)?.focus());
  }

  return <>
    <CenterPageActions context={context} actions={<>
      {group.can_manage && group.status !== "completed" ? <Button id="add-group-requirement" disabled={busy || Boolean(selected || cancelTarget || replacementTarget || requirementEditor || equivalenceEditor)} onClick={() => { setRequirementEditor({ kind: "add" }); setError(""); }}>محاضرة إضافية</Button> : null}
      {group.can_manage && (group.requirements.some(item => item.plan_lecture_id === null) || group.historical_requirements.length > 0) ? <Button id="group-requirement-equivalence" disabled={busy || Boolean(selected || cancelTarget || replacementTarget || requirementEditor || equivalenceEditor)} onClick={() => { setEquivalenceEditor(true); setError(""); }}>تكافؤ المحاضرات المضافة</Button> : null}
      <Link href={`/admin/groups/${group.id}/coverage`}>تقرير تغطية المحتوى وأهلية الإتمام</Link><Link href={explorer ? curriculumExplorerHref({ kind: "level", id: group.level_id, name: group.level_name }, params.toString()) : levelGroupsHref(context.group.level_id)}>العودة للمجموعات</Link>
    </>} />
    <UnsavedChangesGuard dirty={dirty} guardHistory />
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {conflict ? <CenterHeaderActions><Button disabled={busy} onClick={() => void reload().then(() => setNotice("حُمّلت أحدث المواعيد؛ راجع البيانات قبل المعاينة مجددًا.")).catch(failure => setError(failure instanceof Error ? failure.message : "تعذر التحديث."))}>تحميل أحدث البيانات</Button></CenterHeaderActions> : null}
    <section className="context-card form-stack" aria-labelledby={`${formId}-heading`}>
      <h2 id={`${formId}-heading`} tabIndex={-1}>{group.name} · {group.level_name}</h2>
      <p>المحاضرات المعتمدة: {group.required_count.toLocaleString("ar-EG")} · غير المجدولة: {available.length.toLocaleString("ar-EG")}.</p>
      {group.can_manage && group.status !== "completed" && available.length && !equivalenceEditor ? <form id={`${formId}-schedule`} noValidate className="form-stack" onSubmit={event => { event.preventDefault(); if (preview) void confirm(); else void review(); }}>
        <h3>إضافة مواعيد</h3>
        <Field>
          <FieldLabel htmlFor={`${formId}-kind`}>طريقة الإضافة</FieldLabel>
          <NativeSelect id={`${formId}-kind`} value={draft.kind} disabled={busy || conflict} onChange={event => changeDraft({ kind: event.target.value as Draft["kind"] })}>
            <NativeSelectOption value="single">محاضرة واحدة</NativeSelectOption>
            <NativeSelectOption value="weekly">مواعيد أسبوعية متكررة</NativeSelectOption>
          </NativeSelect>
          <FieldDescription>تجدول كل إضافة محاضرة معتمدة للمجموعة؛ لا ترفع العدد المعتمد.</FieldDescription>
        </Field>
        {draft.kind === "single" ? <>
          <Field data-invalid={Boolean(fieldErrors.plan_lecture_number)}><FieldLabel htmlFor={`${formId}-requirement`}>المحاضرة المعتمدة</FieldLabel>
            <NativeSelect id={`${formId}-requirement`} value={draft.plan_lecture_number} disabled={busy || conflict} onChange={event => changeDraft({ plan_lecture_number: event.target.value })}>
              <NativeSelectOption value="">اختر محاضرة غير مجدولة</NativeSelectOption>
              {available.map(item => <NativeSelectOption key={item.number} value={String(item.number)}>{item.number.toLocaleString("ar-EG")} · {item.title || item.content}</NativeSelectOption>)}
            </NativeSelect>
            {fieldErrors.plan_lecture_number ? <FieldError>{fieldErrors.plan_lecture_number}</FieldError> : null}
          </Field>
          <FormField id={`${formId}-title`} label="عنوان الموعد (اختياري)" value={draft.title} onChange={title => changeDraft({ title })} error={fieldErrors.title} disabled={busy || conflict} />
        </> : <>
          <FormField id={`${formId}-count`} label="عدد المواعيد" value={draft.count} onChange={count => changeDraft({ count })} type="number" direction="ltr" error={fieldErrors.count} disabled={busy || conflict} hint={`حتى ٢٠ موعدًا، ضمن ${available.length.toLocaleString("ar-EG")} محاضرة غير مجدولة.`} />
          <FormField id={`${formId}-interval`} label="الفاصل بالأسابيع" value={draft.interval_weeks} onChange={interval_weeks => changeDraft({ interval_weeks })} type="number" direction="ltr" error={fieldErrors.interval_weeks} disabled={busy || conflict} hint="من أسبوع إلى أربعة أسابيع." />
        </>}
        <FormField id={`${formId}-start`} label={draft.kind === "weekly" ? "بداية أول موعد بتوقيت القاهرة" : "موعد المحاضرة بتوقيت القاهرة"} value={draft.start_at} onChange={start_at => changeDraft({ start_at })} type="datetime-local" direction="ltr" error={fieldErrors.start_at} disabled={busy || conflict} required />
        {!preview ? <CenterHeaderActions><Button id={`${formId}-review`} form={`${formId}-schedule`} type="submit" variant="primary" busy={busy} disabled={conflict || !draft.start_at || (draft.kind === "single" && !draft.plan_lecture_number)}>معاينة المواعيد</Button></CenterHeaderActions> : null}
        {preview ? <section className="form-stack" aria-labelledby={`${formId}-preview`}>
          <h3 id={`${formId}-preview`} tabIndex={-1}>تأكيد المواعيد</h3>
          <ol>{preview.sessions.map(item => <li key={item.number}>موعد {item.number.toLocaleString("ar-EG")} · المحاضرة المعتمدة {item.plan_lecture_number.toLocaleString("ar-EG")} · <bdi dir="ltr">{item.local_at.replace("T", " ")}</bdi> القاهرة{item.title ? ` · ${item.title}` : ""}</li>)}</ol>
          <p>راجع الترتيب والمواعيد قبل الحفظ؛ سيتحقق النظام من الحالة مجددًا عند التأكيد.</p>
          <CenterHeaderActions><Button form={`${formId}-schedule`} type="submit" variant="primary" busy={busy} disabled={conflict}>تأكيد وحفظ {preview.sessions.length.toLocaleString("ar-EG")} موعد</Button><Button disabled={busy} onClick={() => { setPreview(null); requestAnimationFrame(() => document.getElementById(`${formId}-review`)?.focus()); }}>إلغاء المعاينة</Button></CenterHeaderActions>
        </section> : null}
      </form> : group.status === "completed" ? <p>المجموعة مكتملة؛ جدولها متاح للقراءة فقط.</p> : !group.can_manage ? <p>جدول المجموعة متاح للقراءة. تعديل المواعيد يتطلب صلاحية إدارة المنهج في الفرع.</p> : <p>جُدولت جميع محاضرات المجموعة المعتمدة.</p>}
    </section>
    {selected ? <form id={`${formId}-postpone-form`} noValidate className="context-card form-stack" aria-label={`تأجيل الموعد ${selected.number}`} onSubmit={event => { event.preventDefault(); void postpone(); }}>
      <h2>تأجيل الموعد {selected.number.toLocaleString("ar-EG")}</h2>
      <p>الوقت الحالي: {formatSessionTime(selected.scheduled_at)} · المحاضرة المعتمدة {selected.plan_lecture_number.toLocaleString("ar-EG")}.</p>
      <FormField id={`${formId}-postpone`} label="الموعد الجديد بتوقيت القاهرة" value={postponeAt} onChange={value => { setPostponeAt(value); setPostponeId(newSubmissionId()); setFieldErrors({}); }} type="datetime-local" direction="ltr" error={fieldErrors.scheduled_at} disabled={busy || conflict} required focusOnMount />
      <FormField id={`${formId}-reason`} label="سبب التأجيل (اختياري)" value={reason} onChange={value => { setReason(value); setPostponeId(newSubmissionId()); setFieldErrors({}); }} error={fieldErrors.reason} disabled={busy || conflict} />
      <CenterHeaderActions><Button form={`${formId}-postpone-form`} type="submit" variant="primary" busy={busy} disabled={conflict || !postponeAt}>حفظ التأجيل</Button><Button disabled={busy} onClick={() => { const id = selected.id; setSelected(null); setPostponeAt(""); setReason(""); requestAnimationFrame(() => document.getElementById(`postpone-${id}`)?.focus()); }}>إلغاء</Button></CenterHeaderActions>
    </form> : null}
    {requirementEditor ? <GroupRequirementEditor key={requirementEditor.kind === "add" ? "add" : requirementEditor.session.id} group={group} mode={requirementEditor}
      onSaved={requirementSaved} onReload={reload} onClose={() => { const id = requirementEditor.kind === "reduce" ? `reduce-${requirementEditor.session.id}` : "add-group-requirement"; setRequirementEditor(null); requestAnimationFrame(() => document.getElementById(id)?.focus()); }} /> : null}
    {equivalenceEditor ? <GroupRequirementEquivalenceEditor group={group}
      onClose={() => { setEquivalenceEditor(false); requestAnimationFrame(() => document.getElementById("group-requirement-equivalence")?.focus()); }} /> : null}
    {cancelTarget ? <form id={`${formId}-cancel-form`} noValidate className="context-card form-stack" aria-label={`إلغاء الموعد ${cancelTarget.number}`} onSubmit={event => { event.preventDefault(); if (cancelPreview) void confirmCancellation(); else void reviewCancellation(); }}>
      <h2>إلغاء الموعد {cancelTarget.number.toLocaleString("ar-EG")} قبل انعقاده</h2>
      <p>المحاضرة المعتمدة {cancelTarget.plan_lecture_number.toLocaleString("ar-EG")} · الوقت الأصلي {formatSessionTime(cancelTarget.scheduled_at)}.</p>
      <FormField id={`${formId}-cancel-reason`} label="سبب الإلغاء" value={cancelReason} onChange={value => { setCancelReason(value); setCancelPreview(null); setCancelId(newSubmissionId()); setFieldErrors({}); }} error={fieldErrors.reason} disabled={busy || conflict} required focusOnMount />
      <Field data-invalid={Boolean(fieldErrors.decision)}><FieldLabel htmlFor={`${formId}-cancel-decision`}>قرار التعويض</FieldLabel>
        <NativeSelect id={`${formId}-cancel-decision`} value={cancelDecision} disabled={busy || conflict} onChange={event => { setCancelDecision(event.target.value as typeof cancelDecision); setCancelPreview(null); setCancelId(newSubmissionId()); }}>
          <NativeSelectOption value="academic">بديل أكاديمي لاحقًا</NativeSelectOption>
          <NativeSelectOption value="financial">إحالة لمراجعة مالية</NativeSelectOption>
          <NativeSelectOption value="none">دون تعويض</NativeSelectOption>
        </NativeSelect>
        <FieldDescription>يُحفظ القرار للمراجعة فقط. لا يُسجل حضور أو غياب أو حركة مالية تلقائيًا، ويبقى متطلب المحاضرة مطلوبًا.</FieldDescription>
        {fieldErrors.decision ? <FieldError>{fieldErrors.decision}</FieldError> : null}
      </Field>
      {cancelPreview ? <section aria-labelledby={`${formId}-cancel-preview`} className="form-stack">
        <h3 id={`${formId}-cancel-preview`} tabIndex={-1}>تأكيد إلغاء الموعد</h3>
        <p>سيُلغى الموعد {cancelTarget.number.toLocaleString("ar-EG")} بتاريخ {formatSessionTime(cancelPreview.scheduled_at)}، وتبقى {cancelPreview.required_count.toLocaleString("ar-EG")} محاضرة معتمدة للمجموعة. القرار: {cancelDecision === "academic" ? "بديل أكاديمي" : cancelDecision === "financial" ? "مراجعة مالية" : "دون تعويض"}.</p>
      </section> : null}
      <CenterHeaderActions><Button form={`${formId}-cancel-form`} type="submit" variant="primary" busy={busy} disabled={conflict || cancelReason.trim().length < 3}>{cancelPreview ? "تأكيد إلغاء الموعد" : "معاينة الإلغاء"}</Button><Button disabled={busy} onClick={() => { const id = cancelTarget.id; setCancelTarget(null); setCancelPreview(null); setCancelReason(""); requestAnimationFrame(() => document.getElementById(`cancel-${id}`)?.focus()); }}>رجوع</Button></CenterHeaderActions>
    </form> : null}
    {replacementTarget ? <form id={`${formId}-replacement-form`} noValidate className="context-card form-stack" aria-label={`بديل للموعد ${replacementTarget.number}`} onSubmit={event => { event.preventDefault(); if (replacementPreview) void confirmReplacement(); else void reviewReplacement(); }}>
      <h2>جدولة بديل للموعد {replacementTarget.number.toLocaleString("ar-EG")}</h2>
      <p>يبقى مرتبطًا بالمحاضرة المعتمدة {replacementTarget.plan_lecture_number.toLocaleString("ar-EG")}؛ لن يزيد عدد المحاضرات المعتمدة.</p>
      <FormField id={`${formId}-replacement-at`} label="موعد البديل بتوقيت القاهرة" value={replacementAt} onChange={value => { setReplacementAt(value); setReplacementPreview(null); setReplacementId(newSubmissionId()); setFieldErrors({}); }} type="datetime-local" direction="ltr" error={fieldErrors.start_at} disabled={busy || conflict} required focusOnMount />
      <FormField id={`${formId}-replacement-title`} label="عنوان البديل (اختياري)" value={replacementTitle} onChange={value => { setReplacementTitle(value); setReplacementPreview(null); setReplacementId(newSubmissionId()); }} error={fieldErrors.title} disabled={busy || conflict} />
      {replacementPreview ? <section aria-labelledby={`${formId}-replacement-preview`} className="form-stack">
        <h3 id={`${formId}-replacement-preview`} tabIndex={-1}>تأكيد الموعد البديل</h3>
        <p>الموعد {replacementPreview.number.toLocaleString("ar-EG")} · المحاضرة المعتمدة {replacementPreview.plan_lecture_number.toLocaleString("ar-EG")} · <bdi dir="ltr">{replacementPreview.local_at.replace("T", " ")}</bdi> القاهرة.</p>
      </section> : null}
      <CenterHeaderActions><Button form={`${formId}-replacement-form`} type="submit" variant="primary" busy={busy} disabled={conflict || !replacementAt}>{replacementPreview ? "تأكيد حفظ البديل" : "معاينة البديل"}</Button><Button disabled={busy} onClick={() => { const id = replacementTarget.id; setReplacementTarget(null); setReplacementPreview(null); setReplacementAt(""); setReplacementTitle(""); requestAnimationFrame(() => document.getElementById(`replacement-${id}`)?.focus()); }}>رجوع</Button></CenterHeaderActions>
    </form> : null}
    <DataTable id="study-sessions" title="مواعيد المحاضرات" description="كل موعد يحتفظ برقمه والمحاضرة المعتمدة المرتبطة به. الأوقات بتوقيت القاهرة." rows={sessions} rowKey={item => item.id} searchText={item => `${item.number} ${item.plan_lecture_number} ${item.title ?? ""} ${item.content}`} emptyMessage="لم تُجدول محاضرات لهذه المجموعة بعد."
      columns={[
        { key: "number", label: "الموعد", render: item => item.number.toLocaleString("ar-EG") },
        { key: "requirement", label: "المحاضرة المعتمدة", render: item => `${item.plan_lecture_number.toLocaleString("ar-EG")} · ${item.content}` },
        { key: "title", label: "العنوان", render: item => item.title || "—" },
        { key: "time", label: "الموعد بتوقيت القاهرة", render: item => formatSessionTime(item.scheduled_at) },
        { key: "status", label: "الحالة", render: item => item.revoked_at ? "أُلغي اعتمادها" : item.status === "planned" ? item.replaces_session_number ? `بديل للموعد ${item.replaces_session_number.toLocaleString("ar-EG")}` : "مخطط" : item.status === "held" ? "أُقيمت" : <span>ملغاة {item.cancelled_at ? `في ${formatSessionTime(item.cancelled_at)}` : ""}{item.cancelled_by_name ? ` بواسطة ${item.cancelled_by_name}` : ""} · {item.compensation_decision === "academic" ? "بديل أكاديمي" : item.compensation_decision === "financial" ? "مراجعة مالية" : "دون تعويض"}{item.replacement_number ? ` · البديل ${item.replacement_number.toLocaleString("ar-EG")}` : ""}{item.cancellation_reason ? ` · السبب: ${item.cancellation_reason}` : ""}</span> },
        { key: "actions", label: "الإجراءات", actions: true, render: item => <span className="flex flex-wrap items-center gap-2">
          {item.status !== "cancelled" ? <Link href={`/admin/groups/${group.id}/sessions/${item.id}/attendance`}>كشف الحضور</Link> : null}
          <Link href={`/admin/groups/${group.id}/sessions/${item.id}/teaching`}>التدريس الفعلي</Link>
          {group.can_manage && group.status !== "completed" && item.status === "planned" && parseSessionTime(item.scheduled_at).getTime() > Date.now()
            ? <Button id={`postpone-${item.id}`} disabled={busy || Boolean(cancelTarget || replacementTarget || selected || requirementEditor || equivalenceEditor)} onClick={() => { setSelected(item); setPostponeAt(""); setReason(""); setPostponeId(newSubmissionId()); setError(""); }}>تأجيل</Button> : null}
          {group.can_manage && group.status !== "completed" && item.status === "planned" ? <Button id={`cancel-${item.id}`} disabled={busy || Boolean(cancelTarget || replacementTarget || selected || requirementEditor || equivalenceEditor)} onClick={() => { setCancelTarget(item); setCancelReason(""); setCancelDecision("academic"); setCancelPreview(null); setCancelId(newSubmissionId()); setError(""); }}>إلغاء الموعد</Button> : null}
          {group.can_manage && group.status !== "completed" && item.status === "cancelled" && ((Boolean(item.cancelled_at) && item.compensation_decision === "academic") || (Boolean(item.revoked_at) && Boolean(item.replaces_session_id))) && !item.replacement_id ? <Button id={`replacement-${item.id}`} disabled={busy || Boolean(cancelTarget || replacementTarget || selected || requirementEditor || equivalenceEditor)} onClick={() => { setReplacementTarget(item); setReplacementAt(""); setReplacementTitle(""); setReplacementPreview(null); setReplacementId(newSubmissionId()); setError(""); }}>جدولة البديل</Button> : null}
          {group.can_manage && group.status !== "completed" && group.required_count > 1 && group.requirements.some(requirement => requirement.number === item.plan_lecture_number) && !item.replacement_id && (item.status === "planned" || (item.status === "cancelled" && Boolean(item.cancelled_at) && (item.compensation_decision === "academic" || item.compensation_decision === "financial" || item.compensation_decision === "none"))) ? <Button id={`reduce-${item.id}`} disabled={busy || Boolean(cancelTarget || replacementTarget || selected || requirementEditor || equivalenceEditor)} onClick={() => { setRequirementEditor({ kind: "reduce", session: item }); setError(""); }}>إلغاء نهائي وخفض العدد</Button> : null}
        </span> },
      ]}
      serverPagination={{ page: context.pagination.page, hasMore: context.pagination.has_more, batchSize: 20,
        previousHref: explorer ? pageHref(Math.max(1, context.pagination.page - 1)) : `/admin/groups/${group.id}/sessions${context.pagination.page > 2 ? `?page=${context.pagination.page - 1}` : ""}`,
        nextHref: explorer ? pageHref(context.pagination.page + 1) : `/admin/groups/${group.id}/sessions?page=${context.pagination.page + 1}` }} />
  </>;
}
