"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions, CenterPageActions } from "@/components/CenterShell";
import { DataTable } from "@/components/DataTable";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { centerRequest, newSubmissionId, responseFieldErrors, responseMessage } from "@/lib/client-api";
import type { SessionContext, StudySession } from "@/lib/groups";
import { formatSessionTime, parseSessionTime } from "@/lib/session-time";

type Draft = { kind: "single" | "weekly"; start_at: string; count: string; interval_weeks: string; plan_lecture_number: string; title: string };
type Preview = { group_revision: number; sessions: { number: number; plan_lecture_number: number; title: string | null; local_at: string }[] };
const initialDraft: Draft = { kind: "single", start_at: "", count: "1", interval_weeks: "1", plan_lecture_number: "", title: "" };

export function SessionControls({ context }: { context: SessionContext }) {
  const router = useRouter();
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
    setPreview(null);
    setConflict(false);
  }
  const dirty = Boolean(preview || JSON.stringify(draft) !== JSON.stringify(initialDraft) || selected || postponeAt || reason);
  const prefix = `groups/${group.id}/sessions`;
  const available = group.requirements.filter(requirement => !group.scheduled_requirements.includes(requirement.number));

  function changeDraft(change: Partial<Draft>) {
    setDraft(current => ({ ...current, ...change }));
    setPreview(null); setRequestId(newSubmissionId()); setError(""); setFieldErrors({});
  }

  function showValidation(errors: Record<string, string>) {
    setFieldErrors(errors);
    const key = Object.keys(errors)[0];
    const input = ({ start_at: "start", plan_lecture_number: "requirement", count: "count", interval_weeks: "interval",
      title: "title", scheduled_at: "postpone", reason: "reason" } as Record<string, string>)[key];
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
      setNotice("حُفظت المواعيد وربطت بمحاضرات الخطة المعتمدة.");
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
      setNotice("تأجل موعد المحاضرة؛ بقي رقمها ومحاضرة الخطة المرتبطة بها كما هما.");
      router.refresh();
      requestAnimationFrame(() => document.getElementById(`postpone-${id}`)?.focus());
    } catch { setError("تعذر التأكد من التأجيل. أعد الطلب نفسه للتحقق من النتيجة."); }
    finally { busyRef.current = false; setBusy(false); }
  }

  return <>
    <p><Link href={`/admin/groups/${group.id}/coverage`}>تقرير تغطية المحتوى وأهلية الإتمام</Link></p>
    <CenterPageActions context={context} actions={<Link href="/admin/groups">العودة للمجموعات</Link>} />
    <UnsavedChangesGuard dirty={dirty} guardHistory />
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {conflict ? <CenterHeaderActions><Button disabled={busy} onClick={() => void reload().then(() => setNotice("حُمّلت أحدث المواعيد؛ راجع البيانات قبل المعاينة مجددًا.")).catch(failure => setError(failure instanceof Error ? failure.message : "تعذر التحديث."))}>تحميل أحدث البيانات</Button></CenterHeaderActions> : null}
    <section className="context-card form-stack" aria-labelledby={`${formId}-heading`}>
      <h2 id={`${formId}-heading`}>{group.name} · {group.level_name}</h2>
      <p>محاضرات الخطة المعتمدة: {group.requirements.length.toLocaleString("ar-EG")} · غير المجدولة: {available.length.toLocaleString("ar-EG")}.</p>
      {group.can_manage && group.status !== "completed" && available.length ? <form id={`${formId}-schedule`} noValidate className="form-stack" onSubmit={event => { event.preventDefault(); if (preview) void confirm(); else void review(); }}>
        <h3>إضافة مواعيد</h3>
        <Field>
          <FieldLabel htmlFor={`${formId}-kind`}>طريقة الإضافة</FieldLabel>
          <NativeSelect id={`${formId}-kind`} value={draft.kind} disabled={busy || conflict} onChange={event => changeDraft({ kind: event.target.value as Draft["kind"] })}>
            <NativeSelectOption value="single">محاضرة واحدة</NativeSelectOption>
            <NativeSelectOption value="weekly">مواعيد أسبوعية متكررة</NativeSelectOption>
          </NativeSelect>
          <FieldDescription>تستهلك كل إضافة محاضرة موجودة من إصدار الخطة؛ لا ترفع العدد المعتمد.</FieldDescription>
        </Field>
        {draft.kind === "single" ? <>
          <Field data-invalid={Boolean(fieldErrors.plan_lecture_number)}><FieldLabel htmlFor={`${formId}-requirement`}>محاضرة الخطة</FieldLabel>
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
          <ol>{preview.sessions.map(item => <li key={item.number}>موعد {item.number.toLocaleString("ar-EG")} · محاضرة الخطة {item.plan_lecture_number.toLocaleString("ar-EG")} · <bdi dir="ltr">{item.local_at.replace("T", " ")}</bdi> القاهرة{item.title ? ` · ${item.title}` : ""}</li>)}</ol>
          <p>راجع الترتيب والمواعيد قبل الحفظ؛ سيتحقق النظام من الحالة مجددًا عند التأكيد.</p>
          <CenterHeaderActions><Button form={`${formId}-schedule`} type="submit" variant="primary" busy={busy} disabled={conflict}>تأكيد وحفظ {preview.sessions.length.toLocaleString("ar-EG")} موعد</Button><Button disabled={busy} onClick={() => { setPreview(null); requestAnimationFrame(() => document.getElementById(`${formId}-review`)?.focus()); }}>إلغاء المعاينة</Button></CenterHeaderActions>
        </section> : null}
      </form> : group.status === "completed" ? <p>المجموعة مكتملة؛ جدولها متاح للقراءة فقط.</p> : !group.can_manage ? <p>جدول المجموعة متاح للقراءة. تعديل المواعيد يتطلب صلاحية إدارة المنهج في الفرع.</p> : <p>جُدولت جميع محاضرات الخطة المعتمدة.</p>}
    </section>
    {selected ? <form id={`${formId}-postpone-form`} noValidate className="context-card form-stack" aria-label={`تأجيل الموعد ${selected.number}`} onSubmit={event => { event.preventDefault(); void postpone(); }}>
      <h2>تأجيل الموعد {selected.number.toLocaleString("ar-EG")}</h2>
      <p>الوقت الحالي: {formatSessionTime(selected.scheduled_at)} · محاضرة الخطة {selected.plan_lecture_number.toLocaleString("ar-EG")}.</p>
      <FormField id={`${formId}-postpone`} label="الموعد الجديد بتوقيت القاهرة" value={postponeAt} onChange={value => { setPostponeAt(value); setPostponeId(newSubmissionId()); setFieldErrors({}); }} type="datetime-local" direction="ltr" error={fieldErrors.scheduled_at} disabled={busy || conflict} required focusOnMount />
      <FormField id={`${formId}-reason`} label="سبب التأجيل (اختياري)" value={reason} onChange={value => { setReason(value); setPostponeId(newSubmissionId()); setFieldErrors({}); }} error={fieldErrors.reason} disabled={busy || conflict} />
      <CenterHeaderActions><Button form={`${formId}-postpone-form`} type="submit" variant="primary" busy={busy} disabled={conflict || !postponeAt}>حفظ التأجيل</Button><Button disabled={busy} onClick={() => { const id = selected.id; setSelected(null); setPostponeAt(""); setReason(""); requestAnimationFrame(() => document.getElementById(`postpone-${id}`)?.focus()); }}>إلغاء</Button></CenterHeaderActions>
    </form> : null}
    <DataTable id="study-sessions" title="مواعيد المحاضرات" description="كل موعد يحتفظ برقمه ومحاضرة خطته. الأوقات بتوقيت القاهرة." rows={sessions} rowKey={item => item.id} searchText={item => `${item.number} ${item.plan_lecture_number} ${item.title ?? ""} ${item.content}`} emptyMessage="لم تُجدول محاضرات لهذه المجموعة بعد."
      columns={[
        { key: "number", label: "الموعد", render: item => item.number.toLocaleString("ar-EG") },
        { key: "requirement", label: "محاضرة الخطة", render: item => `${item.plan_lecture_number.toLocaleString("ar-EG")} · ${item.content}` },
        { key: "title", label: "العنوان", render: item => item.title || "—" },
        { key: "time", label: "الموعد بتوقيت القاهرة", render: item => formatSessionTime(item.scheduled_at) },
        { key: "status", label: "الحالة", render: item => item.status === "planned" ? "مخطط" : item.status === "held" ? "أُقيمت" : "ملغاة" },
        { key: "actions", label: "الإجراءات", actions: true, render: item => <span className="flex flex-wrap items-center gap-2">
          <Link href={`/admin/groups/${group.id}/sessions/${item.id}/attendance`}>كشف الحضور</Link>
          {group.can_manage && group.status !== "completed" && item.status === "planned" && parseSessionTime(item.scheduled_at).getTime() > Date.now()
            ? <Button id={`postpone-${item.id}`} disabled={busy} onClick={() => { setSelected(item); setPostponeAt(""); setReason(""); setPostponeId(newSubmissionId()); setError(""); }}>تأجيل</Button> : null}
        </span> },
      ]}
      serverPagination={{ page: context.pagination.page, hasMore: context.pagination.has_more, batchSize: 20,
        previousHref: `/admin/groups/${group.id}/sessions${context.pagination.page > 2 ? `?page=${context.pagination.page - 1}` : ""}`,
        nextHref: `/admin/groups/${group.id}/sessions?page=${context.pagination.page + 1}` }} />
  </>;
}
