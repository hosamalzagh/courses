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
type Group = StudyEnrollmentContext["groups"][number];
type Preview = {
  hash: string; revision: number; group_revision: number;
  to: { group_id: string; group_name: string; branch_id: number; level_id: string; level_name: string;
    plan_version_id: string; plan_version: number; completion_threshold: number };
  required_count: number; credited_count: number; credited_numbers: number[]; missing_numbers: number[];
  approval_count: number; equivalence_ready: boolean; balance: { debt: string; available_credit: string };
};
type HistoryContext = { branch_id: number; branch_name: string; level_id: string; level_name: string;
  plan_version_id: string; plan_version: number; group_id: string | null; group_name: string | null };
type History = { id: string; transferred_on: string; from: HistoryContext | null;
  to: HistoryContext | null;
  reason: string | null; actor_name: string | null; credited_count: number; required_count: number };

export function StudyTransferEditor({ studentId, attempt, groups, groupsHasMore, currency, onClose, onSaved, onReload, onDirtyChange }: {
  studentId: string; attempt: Attempt; groups: Group[]; groupsHasMore: boolean; currency: string | null;
  onClose: () => void; onSaved: () => void; onReload: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const prefix = useId();
  const base = `students/${studentId}/enrollments/${attempt.id}/transfer`;
  const [groupId, setGroupId] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [choices, setChoices] = useState(groups);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [groupsPage, setGroupsPage] = useState(1);
  const [hasMoreGroups, setHasMoreGroups] = useState(groupsHasMore);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const initialChoicesLoaded = useRef(false);
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef<string | null>(null);
  const previewGeneration = useRef(0);
  const submitting = useRef(false);
  const dirty = Boolean(groupId || date || reason);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (!initialChoicesLoaded.current) { initialChoicesLoaded.current = true; return; }
    let cancelled = false;
    centerRequest(`students/${studentId}/enrollments?${new URLSearchParams({ q: query, groups_page: String(groupsPage) })}`, "GET")
      .then(async response => {
        if (!response.ok) throw new Error(await responseMessage(response));
        return response.json() as Promise<StudyEnrollmentContext>;
      }).then(data => {
        if (cancelled) return;
        setChoices(data.groups); setHasMoreGroups(data.pagination.groups_has_more); setLoadingGroups(false);
      }).catch(cause => { if (!cancelled) { setLoadingGroups(false); setError(cause instanceof Error ? cause.message : "تعذر تحميل مجموعات الوجهة."); } });
    return () => { cancelled = true; };
  }, [studentId, query, groupsPage]);

  function changeGroup(value: string) { previewGeneration.current++; setGroupId(value); setSelectedGroup(choices.find(group => group.id === value) ?? null); setPreview(null); setHistory([]); setHistoryPage(1); setLoading(false); setError(""); requestId.current = null; }
  function changeDate(value: string) { previewGeneration.current++; setDate(value); setPreview(null); setHistory([]); setHistoryPage(1); setLoading(false); setError(""); requestId.current = null; }
  function changeReason(value: string) { setReason(value); setError(""); requestId.current = null; }

  async function loadPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || uncertain || conflict) return;
    if (!groupId || !date) {
      setError("اختر المجموعة وتاريخ النقل أولًا.");
      document.getElementById(!groupId ? `${prefix}-group` : `${prefix}-date`)?.focus(); return;
    }
    await fetchPreview(1);
  }

  async function fetchPreview(page: number) {
    const generation = ++previewGeneration.current;
    setLoading(true); setError("");
    if (page === 1) setPreview(null);
    try {
      const params = new URLSearchParams({ group_id: groupId, transferred_on: date, history_page: String(page) });
      const response = await centerRequest(`${base}/preview?${params}`, "GET");
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = await response.json() as { preview: Preview; history: History[]; history_page: number; history_has_more: boolean };
      if (generation !== previewGeneration.current) return;
      setPreview(result.preview); setHistory(result.history); setHistoryPage(result.history_page);
      setHistoryHasMore(result.history_has_more);
    } catch (cause) { if (generation === previewGeneration.current) setError(cause instanceof Error ? cause.message : "تعذرت معاينة النقل."); }
    finally { if (generation === previewGeneration.current) setLoading(false); }
  }

  function prepare() {
    if (!preview || busy || conflict) return;
    if (reason.trim().length === 0 || reason.trim().length > 2000) {
      setError("أدخل سبب النقل حتى ٢٠٠٠ حرف."); document.getElementById(`${prefix}-reason`)?.focus(); return;
    }
    if (!preview.equivalence_ready) {
      setError("اعتمد معادلة بين إصدار الخطة الحالي وإصدار الوجهة قبل النقل."); return;
    }
    setError(""); setConfirm(true);
  }

  async function save() {
    if (submitting.current || !preview) return;
    submitting.current = true; setBusy(true); setConfirm(false); setError("");
    try {
      requestId.current ??= newSubmissionId();
      const response = await centerRequest(base, "POST", {
        group_id: groupId, group_revision: preview.group_revision, transferred_on: date,
        revision: preview.revision, preview_hash: preview.hash, reason: reason.trim(), request_id: requestId.current,
      });
      if (!response.ok) {
        if (response.status === 409) {
          setConflict(true); setUncertain(false);
          setError("تغيرت المحاولة أو المجموعة أو التغطية أو المعادلة. حمّل أحدث البيانات ثم عاين القرار مرة أخرى.");
        } else { setUncertain(false); setError(await responseMessage(response)); }
        return;
      }
      onDirtyChange(false); onSaved(); onClose();
    } catch { setUncertain(true); setError("تعذر التأكد من النقل. أعد إرسال القرار نفسه للتحقق بالمفتاح ذاته."); }
    finally { submitting.current = false; setBusy(false); }
  }

  const selected = choices.find(group => group.id === groupId) ?? (selectedGroup?.id === groupId ? selectedGroup : null);
  return <section className="context-card form-stack" aria-label="نقل الطالب بين المجموعات والفروع">
    <h2>نقل {attempt.level_name} داخل المحاولة نفسها</h2>
    <p className="muted">تظل المحاولة والحضور والرسوم السابقة محفوظة بمصادرها. يعرض النقل خطة الوجهة وتغطيتها قبل التأكيد، دون رسوم أو تخصيص جديد.</p>
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    <form onSubmit={event => { event.preventDefault(); if (search.trim() !== query || groupsPage !== 1) {
      setLoadingGroups(true); setGroupsPage(1); setQuery(search.trim());
    } }}>
      <FormField id={`${prefix}-search`} label="بحث عن مجموعة وجهة" value={search} onChange={setSearch} />
      <Button type="submit" disabled={loadingGroups || busy || uncertain || conflict}>بحث</Button>
    </form>
    <form id={`${prefix}-transfer-form`} onSubmit={loadPreview} noValidate><FieldGroup>
      <Field data-invalid={Boolean(error && !groupId)}>
        <FieldLabel htmlFor={`${prefix}-group`}>مجموعة الوجهة</FieldLabel>
        <NativeSelect id={`${prefix}-group`} value={groupId} onChange={event => changeGroup(event.target.value)} disabled={loadingGroups || busy || uncertain || conflict}>
          <NativeSelectOption value="">اختر مجموعة من الفروع المصرح بها</NativeSelectOption>
          {choices.filter(group => group.id !== attempt.current_group_id).map(group => <NativeSelectOption key={group.id} value={group.id}>
            {group.branch_name} — {group.level_name} — {group.name}
          </NativeSelectOption>)}
          {selectedGroup && !choices.some(group => group.id === selectedGroup.id) ? <NativeSelectOption value={selectedGroup.id}>
            {selectedGroup.branch_name} — {selectedGroup.level_name} — {selectedGroup.name}
          </NativeSelectOption> : null}
        </NativeSelect>
        {error && !groupId ? <FieldError>مجموعة الوجهة مطلوبة.</FieldError> : null}
      </Field>
      <FormField id={`${prefix}-date`} label="تاريخ النقل الفعلي" type="date" value={date} onChange={changeDate}
        disabled={busy || uncertain || conflict} />
      <Field>
        <FieldLabel htmlFor={`${prefix}-reason`}>سبب النقل</FieldLabel>
        <Textarea id={`${prefix}-reason`} value={reason} onChange={event => changeReason(event.target.value)} maxLength={2000}
          disabled={busy || uncertain || conflict} />
      </Field>
    </FieldGroup>
      <div className="form-actions">
        <Button type="button" onClick={() => { setLoadingGroups(true); setGroupsPage(page => page - 1); }} disabled={groupsPage <= 1 || loadingGroups || busy}>المجموعات السابقة</Button>
        <Button type="button" onClick={() => { setLoadingGroups(true); setGroupsPage(page => page + 1); }} disabled={!hasMoreGroups || loadingGroups || busy}>المجموعات التالية</Button>
      </div>
    </form>
    {preview ? <section className="context-card form-stack" aria-label="معاينة متطلبات الوجهة">
      <h3>{preview.to.level_name} — {preview.to.group_name}، إصدار الخطة {preview.to.plan_version.toLocaleString("ar-EG")}</h3>
      <p>متطلبات الوجهة: {preview.required_count.toLocaleString("ar-EG")}، المحتسب: {preview.credited_count.toLocaleString("ar-EG")}، الناقص: {preview.missing_numbers.length.toLocaleString("ar-EG")}</p>
      <p>المحاضرات المحتسبة: {preview.credited_numbers.join("، ") || "لا توجد"} — الناقصة: {preview.missing_numbers.join("، ") || "لا توجد"}</p>
      <p>اعتمادات المعادلة المستخدمة: {preview.approval_count.toLocaleString("ar-EG")}</p>
      {!preview.equivalence_ready ? <InlineNotice tone="warning">لا توجد معادلة معتمدة من إصدار الخطة الحالي إلى إصدار الوجهة. اعتمدها قبل التأكيد.</InlineNotice> : null}
      <p>مديونية الفروع المصرح بها: <bdi dir="ltr">{preview.balance.debt} {currency ?? ""}</bdi> — الرصيد المقدم المتاح: <bdi dir="ltr">{preview.balance.available_credit} {currency ?? ""}</bdi></p>
      {Number(preview.balance.debt) > 0 ? <InlineNotice tone="warning">المديونية تحذير؛ يمكن النقل دون تسوية مالية تلقائية.</InlineNotice> : null}
      {Number(preview.balance.available_credit) > 0 ? <p className="muted">يبقى الرصيد المقدم متاحًا للتخصيص المالي المصرح به، ولا يُستخدم في هذا النقل.</p> : null}
    </section> : null}
    <CenterHeaderActions>
      {preview ? <Button variant="primary" onClick={prepare} busy={busy} disabled={conflict || loading || !preview.equivalence_ready}>
        {uncertain ? "التحقق من النقل" : "تأكيد النقل"}
      </Button> : <Button form={`${prefix}-transfer-form`} type="submit" variant="primary" busy={loading}
        disabled={busy || uncertain || conflict || !selected}>معاينة النقل</Button>}
      <Button onClick={onClose} disabled={busy || uncertain}>إلغاء</Button>
      {conflict ? <Button onClick={onReload}>تحميل أحدث البيانات</Button> : null}
    </CenterHeaderActions>
    {history.length ? <DataTable id={`${prefix}-history`} title="سجل النقل" rows={history} rowKey={row => row.id}
      searchText={row => `${row.transferred_on} ${row.reason ?? ""}`} emptyMessage="لا يوجد نقل سابق."
      columns={[
        { key: "date", label: "التاريخ", render: row => <bdi dir="ltr">{row.transferred_on}</bdi> },
        { key: "source", label: "السياق السابق", render: row => row.from
          ? `${row.from.branch_name} — ${row.from.level_name} — خطة ${row.from.plan_version} — ${row.from.group_name ?? "انتظار"}` : "سياق محجوب" },
        { key: "destination", label: "الوجهة", render: row => row.to
          ? `${row.to.branch_name} — ${row.to.level_name} — خطة ${row.to.plan_version} — ${row.to.group_name ?? "انتظار"}` : "سياق محجوب" },
        { key: "coverage", label: "التغطية عند النقل", render: row => `${row.credited_count}/${row.required_count}` },
        { key: "reason", label: "السبب", render: row => row.reason ?? "محجوب" },
      ]} /> : null}
    {preview && (historyPage > 1 || historyHasMore) ? <div className="form-actions">
      <Button type="button" disabled={historyPage <= 1 || loading || busy} onClick={() => void fetchPreview(historyPage - 1)}>السجل السابق</Button>
      <Button type="button" disabled={!historyHasMore || loading || busy} onClick={() => void fetchPreview(historyPage + 1)}>السجل التالي</Button>
    </div> : null}
    {confirm ? <ConfirmationDialog title="تأكيد نقل المحاولة" description="ستتغير المجموعة والخطة الحالية مع حفظ تاريخ الفرع والحضور والرسوم السابقة. لن تُنشأ حركة مالية."
      confirmLabel="نقل المحاولة" onCancel={() => setConfirm(false)} onConfirm={save} /> : null}
  </section>;
}
