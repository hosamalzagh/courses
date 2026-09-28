"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { DataTable } from "@/components/DataTable";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";
import type { StudyEnrollmentContext } from "@/lib/server-context";

type Attempt = StudyEnrollmentContext["attempts"][number];
type Waitlist = NonNullable<Attempt["latest_waitlist"]>;
type Options = { attempt_revision: number; groups: { id: string; name: string; revision: number }[];
  history: Waitlist[]; pagination: { page: number; has_more: boolean; history_page: number; history_has_more: boolean } };

export function StudyWaitlistEditor({ studentId, attempt, onClose, onSaved, onReload, onDirtyChange }: {
  studentId: string; attempt: Attempt; onClose: () => void; onSaved: () => void; onReload: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const prefix = useId();
  const waiting = attempt.current_group_id === null;
  const base = `students/${studentId}/enrollments/${attempt.id}`;
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [groupId, setGroupId] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [historyPage, setHistoryPage] = useState(1);
  const [options, setOptions] = useState<Options | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  const dirty = Boolean(date || reason || groupId);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ page: String(page), history_page: String(historyPage), ...(query ? { q: query } : {}) });
    centerRequest(`${base}/waitlist?${params}`, "GET").then(async response => {
      if (!response.ok) throw new Error(await responseMessage(response));
      return response.json() as Promise<Options>;
    }).then(data => {
      if (cancelled) return;
      setOptions(data); setLoading(false); setError("");
    }).catch(cause => { if (!cancelled) { setLoading(false); setError(cause instanceof Error ? cause.message : "تعذر تحميل تاريخ الانتظار."); } });
    return () => { cancelled = true; };
  }, [base, page, historyPage, query]);

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || conflict || loading) return;
    if (!date || (waiting && date < (attempt.latest_waitlist?.entered_on ?? attempt.joined_on)) ||
      (!waiting && date < attempt.joined_on)) {
      setError("راجع التاريخ؛ لا يجوز أن يسبق تاريخ الارتباط أو بداية الانتظار.");
      document.getElementById(`${prefix}-date`)?.focus(); return;
    }
    if (waiting && !options?.groups.some(group => group.id === groupId)) {
      setError("اختر مجموعة من المجموعات المطابقة لإصدار الخطة في الفرع نفسه.");
      document.getElementById(`${prefix}-group`)?.focus(); return;
    }
    if (!waiting && (!reason.trim() || reason.trim().length > 2000)) {
      setError("أدخل سبب الانتظار حتى ٢٠٠٠ حرف.");
      document.getElementById(`${prefix}-reason`)?.focus(); return;
    }
    setError(""); setConfirm(true);
  }

  async function save() {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setConfirm(false); setError("");
    try {
      requestId.current ??= newSubmissionId();
      const selected = options?.groups.find(group => group.id === groupId);
      const response = await centerRequest(`${base}/${waiting ? "reattach" : "waitlist"}`, "POST", waiting
        ? { group_id: groupId, group_revision: selected?.revision, joined_on: date, revision: attempt.revision, request_id: requestId.current }
        : { entered_on: date, reason: reason.trim(), revision: attempt.revision, request_id: requestId.current });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setUncertain(false); setError("تغيرت المحاولة أو المجموعة. حمّل أحدث البيانات قبل القرار."); }
        else setError(await responseMessage(response));
        return;
      }
      onDirtyChange(false); onSaved(); onClose();
    } catch {
      setUncertain(true); setError("تعذر التأكد من القرار. أعد الطلب نفسه للتحقق دون تكراره.");
    } finally { submitting.current = false; setBusy(false); }
  }

  return <section className="context-card form-stack" aria-label={waiting ? "إعادة إلحاق الطالب" : "نقل الطالب إلى انتظار المستوى"}>
    <h2>{waiting ? `إعادة إلحاق ${attempt.level_name}` : `انتظار ${attempt.level_name}`}</h2>
    <p className="muted">{waiting
      ? "يستمر الطالب في المحاولة وإصدار الخطة والرسوم نفسيهما، وتبدأ فترة غياب تشغيلية جديدة عند الإلحاق."
      : "يغلق ارتباط المجموعة بتاريخ الانتظار دون حذف حضورها أو تغطيتها. تبقى الرسوم والمديونية كما هي."}</p>
    {attempt.latest_waitlist ? <p>آخر انتظار: <bdi dir="ltr">{attempt.latest_waitlist.entered_on}</bdi> — {attempt.latest_waitlist.reason}</p> : null}
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {loading ? <p role="status">جارٍ تحميل المجموعات والتاريخ…</p> : null}
    {waiting ? <>
      <form onSubmit={event => { event.preventDefault(); setPage(1); setQuery(search.trim()); }}>
        <FormField id={`${prefix}-search`} label="بحث عن مجموعة بنفس إصدار الخطة" value={search} onChange={setSearch} />
        <Button type="submit" disabled={loading || busy}>بحث</Button>
      </form>
      <Field data-invalid={Boolean(error && !groupId)}>
        <FieldLabel htmlFor={`${prefix}-group`}>المجموعة الجديدة</FieldLabel>
        <NativeSelect id={`${prefix}-group`} value={groupId} onChange={event => setGroupId(event.target.value)} disabled={loading || busy || uncertain || conflict}>
          <NativeSelectOption value="">اختر مجموعة</NativeSelectOption>
          {options?.groups.map(group => <NativeSelectOption key={group.id} value={group.id}>{group.name}</NativeSelectOption>)}
        </NativeSelect>
        {error && !groupId ? <FieldError>المجموعة مطلوبة.</FieldError> : null}
      </Field>
      <div className="form-actions">
        <Button type="button" disabled={page <= 1 || loading || busy} onClick={() => setPage(page - 1)}>المجموعات السابقة</Button>
        <Button type="button" disabled={!options?.pagination.has_more || loading || busy} onClick={() => setPage(page + 1)}>المجموعات التالية</Button>
      </div>
    </> : null}
    <form id={`${prefix}-wait-form`} onSubmit={prepare} noValidate><FieldGroup>
      <FormField id={`${prefix}-date`} label={waiting ? "تاريخ الإلحاق الفعلي" : "تاريخ بداية الانتظار"} type="date"
        value={date} onChange={setDate} disabled={busy || uncertain || conflict} />
      {!waiting ? <Field data-invalid={Boolean(error && !reason.trim())}>
        <FieldLabel htmlFor={`${prefix}-reason`}>سبب الانتظار</FieldLabel>
        <Textarea id={`${prefix}-reason`} value={reason} onChange={event => setReason(event.target.value)} maxLength={2000}
          disabled={busy || uncertain || conflict} aria-invalid={Boolean(error && !reason.trim())} />
        {error && !reason.trim() ? <FieldError>السبب مطلوب.</FieldError> : null}
      </Field> : null}
    </FieldGroup></form>
    <CenterHeaderActions>
      <Button form={`${prefix}-wait-form`} type="submit" variant="primary" busy={busy} disabled={conflict || loading}>
        {uncertain ? "التحقق من القرار" : waiting ? "إعادة الإلحاق" : "نقل إلى الانتظار"}
      </Button>
      <Button type="button" disabled={busy || uncertain} onClick={onClose}>إلغاء</Button>
      {conflict ? <Button type="button" onClick={onReload}>تحميل أحدث البيانات</Button> : null}
    </CenterHeaderActions>
    {options?.history.length ? <DataTable id={`${prefix}-wait-history`} title="سجل انتظار المستوى" rows={options.history} rowKey={row => row.id}
      searchText={row => `${row.reason} ${row.entered_by_name} ${row.entered_on}`} emptyMessage="لا يوجد انتظار مسجل."
      columns={[
        { key: "entered", label: "بدأ", render: row => <bdi dir="ltr">{row.entered_on}</bdi> },
        { key: "left", label: "انتهى", render: row => row.left_on ? <bdi dir="ltr">{row.left_on}</bdi> : "مستمر" },
        { key: "reason", label: "السبب", render: row => row.reason },
        { key: "actor", label: "نقله", render: row => row.entered_by_name },
      ]} /> : null}
    {options && (options.pagination.history_page > 1 || options.pagination.history_has_more) ? <div className="form-actions">
      <Button type="button" disabled={historyPage <= 1 || loading} onClick={() => setHistoryPage(historyPage - 1)}>السجل السابق</Button>
      <Button type="button" disabled={!options.pagination.history_has_more || loading} onClick={() => setHistoryPage(historyPage + 1)}>السجل التالي</Button>
    </div> : null}
    {confirm ? <ConfirmationDialog title={waiting ? "تأكيد إعادة الإلحاق" : "تأكيد الانتظار"}
      description={waiting ? "ستبدأ فترة مجموعة جديدة داخل المحاولة نفسها دون رسوم جديدة." : "ستغلق فترة المجموعة الحالية ويبقى تاريخ الدراسة والمال محفوظًا."}
      confirmLabel={waiting ? "تأكيد الإلحاق" : "تأكيد الانتظار"} onCancel={() => setConfirm(false)} onConfirm={save} /> : null}
  </section>;
}
