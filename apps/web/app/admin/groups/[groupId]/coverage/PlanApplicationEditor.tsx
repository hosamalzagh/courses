"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { DataTable } from "@/components/DataTable";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";
import type { CoverageContext, CoverageRow } from "@/lib/groups";

type Version = { id: string; version: number; required_count: number };
type Requirement = { id: string; number: number; content: string; title?: string | null };
type Coverage = { required_count: number; covered_count: number; percentage: number; needed: number;
  covered_numbers: number[]; missing_numbers: number[]; open_numbers: number[]; eligible: boolean; provisional: boolean };
type StudentImpact = { attempt_id: string; name: string; student_number: number; from_plan_version: number;
  before_requirements: Requirement[]; before: Coverage; after: Coverage;
  completion_decision: { id: string; exceptional: boolean } | null };
type Preview = { group_revision: number; target_plan_version: number;
  target_requirements: Requirement[]; students: StudentImpact[]; preview_token: string };

export function PlanApplicationEditor({ context, onSaved, onReload, onClose }: {
  context: CoverageContext; onSaved: () => void; onReload: () => void; onClose: () => void;
}) {
  const formId = useId();
  const busyRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [versionPage, setVersionPage] = useState(1);
  const [versionSearch, setVersionSearch] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [requestId, setRequestId] = useState(newSubmissionId);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [closePrompt, setClosePrompt] = useState(false);

  const groupId = context.group.id;
  const editable = context.students.filter(row => ["active", "completed"].includes(row.attempt_status));
  const draft = selected.length > 0 || targetId !== "" || reason !== "" || preview !== null;

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  function invalidate() { setPreview(null); setRequestId(newSubmissionId()); setError(""); setConflict(false); }
  const loadVersions = useCallback(async (page: number, q: string) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (q.trim()) params.set("q", q.trim());
      const response = await centerRequest(`groups/${groupId}/plan-applications/options?${params}`, "GET");
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const result = await response.json() as { versions: Version[]; pagination: { has_more: boolean } };
      setVersions(current => page > 1 ? [...current, ...result.versions] : result.versions);
      setVersionPage(page); setHasMore(result.pagination.has_more); setLoaded(true);
    } catch { setError("تعذر تحميل إصدارات الخطة. حاول مرة أخرى."); }
    finally { busyRef.current = false; setBusy(false); }
  }, [groupId]);
  useEffect(() => {
    const timeout = window.setTimeout(() => void loadVersions(1, ""), 0);
    return () => window.clearTimeout(timeout);
  }, [loadVersions]);
  async function review() {
    if (busyRef.current || !targetId || !selected.length || reason.trim().length < 3) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const response = await centerRequest(`groups/${groupId}/plan-applications/preview`, "POST", {
        target_plan_version_id: targetId, attempt_ids: selected, reason: reason.trim(),
      });
      if (!response.ok) { if (response.status === 409) setConflict(true); setError(await responseMessage(response)); return; }
      setPreview(await response.json() as Preview);
      requestAnimationFrame(() => document.getElementById(`${formId}-preview`)?.focus());
    } catch { setError("تعذرت معاينة أثر إصدار الخطة. حاول مرة أخرى."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function confirm() {
    if (busyRef.current || !preview) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const response = await centerRequest(`groups/${groupId}/plan-applications`, "POST", {
        target_plan_version_id: targetId, attempt_ids: selected, reason: reason.trim(),
        group_revision: preview.group_revision, preview_token: preview.preview_token, request_id: requestId,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setPreview(null); }
        setError(await responseMessage(response)); return;
      }
      onSaved();
    } catch { setError("انقطع الاتصال أثناء الاعتماد. أعد الطلب نفسه للتحقق من النتيجة؛ لن يتكرر التطبيق."); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const coverageText = (coverage: Coverage) => `${coverage.covered_count.toLocaleString("ar-EG")}/${coverage.required_count.toLocaleString("ar-EG")} · ${coverage.percentage.toLocaleString("ar-EG")}% · يلزم ${coverage.needed.toLocaleString("ar-EG")} · ${coverage.eligible ? "بلغ الحد" : "ناقص"}${coverage.provisional ? " مبدئيًا حتى إغلاق المحاضرة" : ""}`;

  return <form id={`${formId}-form`} className="form-stack" noValidate onSubmit={event => { event.preventDefault(); if (preview) void confirm(); else void review(); }}>
    <h2 className="text-lg font-semibold">تطبيق إصدار خطة جديد على محاولات مختارة</h2>
    <p>مجموعة {context.group.name} تظل على إصدارها ومحاضراتها الفعلية. التغيير يخص متطلبات المحاولات المختارة فقط، ولا يغير الحضور أو الرسوم أو قرارات الإتمام السابقة.</p>
    <FormField id={`${formId}-search`} label="ابحث عن رقم إصدار الخطة" value={versionSearch} onChange={value => setVersionSearch(value)} disabled={busy} />
    <CenterHeaderActions>
      <Button type="button" disabled={busy} onClick={() => void loadVersions(1, versionSearch)}>بحث في الإصدارات</Button>
      {hasMore ? <Button type="button" disabled={busy} onClick={() => void loadVersions(versionPage + 1, versionSearch)}>إصدارات أخرى</Button> : null}
    </CenterHeaderActions>
    <Field>
      <FieldLabel htmlFor={`${formId}-version`}>الإصدار الجديد</FieldLabel>
      <NativeSelect id={`${formId}-version`} value={targetId} disabled={busy || !loaded || conflict}
        onChange={event => { setTargetId(event.target.value); invalidate(); }}>
        <NativeSelectOption value="">اختر إصدارًا أحدث</NativeSelectOption>
        {versions.map(version => <NativeSelectOption key={version.id} value={version.id}>
          الإصدار {version.version.toLocaleString("ar-EG")} · {version.required_count.toLocaleString("ar-EG")} محاضرات
        </NativeSelectOption>)}
      </NativeSelect>
      <FieldDescription>تظهر المحاضرات المحتسبة بالمعادلات المعتمدة فقط في المعاينة.</FieldDescription>
    </Field>
    <Field>
      <FieldLabel htmlFor={`${formId}-reason`}>سبب التطبيق</FieldLabel>
      <Textarea id={`${formId}-reason`} value={reason} maxLength={1000} disabled={busy || conflict}
        onChange={event => { setReason(event.target.value); invalidate(); }} />
    </Field>
    <DataTable id="plan-application-attempts" title="المحاولات في هذه الصفحة" rows={editable}
      rowKey={row => row.attempt_id} searchText={row => `${row.name} ${row.student_number}`}
      emptyMessage="لا توجد محاولات قابلة للاختيار في هذه الصفحة."
      columns={[
        { key: "select", label: "اختيار", render: (row: CoverageRow) => <Checkbox
          checked={selected.includes(row.attempt_id)} disabled={busy || conflict}
          aria-label={`اختيار محاولة ${row.name} لتطبيق إصدار الخطة`}
          onCheckedChange={checked => { setSelected(current => checked
            ? [...current.filter(id => id !== row.attempt_id), row.attempt_id]
            : current.filter(id => id !== row.attempt_id)); invalidate(); }} /> },
        { key: "student", label: "الطالب", render: row => `${row.name} · ${row.student_number.toLocaleString("ar-EG")}` },
        { key: "current", label: "الحالي", render: row => `إصدار ${row.plan_version.toLocaleString("ar-EG")} · ${row.covered_count.toLocaleString("ar-EG")}/${row.required_count.toLocaleString("ar-EG")} · ${row.percentage.toLocaleString("ar-EG")}%` },
        { key: "decision", label: "الإتمام السابق", render: row => row.approved_at ? "قرار محفوظ" : "لا يوجد" },
      ]} />
    {error ? <div ref={errorRef} tabIndex={-1}><InlineNotice tone="error">{error}{conflict ? " حمّل أحدث التقرير وأعد المعاينة." : ""}</InlineNotice></div> : null}
    {preview ? <section className="form-stack" aria-labelledby={`${formId}-preview`}>
      <h3 id={`${formId}-preview`} tabIndex={-1}>أثر الإصدار {preview.target_plan_version.toLocaleString("ar-EG")} قبل الاعتماد</h3>
      <details><summary>متطلبات الإصدار المقترح ({preview.target_requirements.length.toLocaleString("ar-EG")})</summary>
        <ol>{preview.target_requirements.map(requirement => <li key={requirement.id}>
          {requirement.number.toLocaleString("ar-EG")}. {requirement.title ? `${requirement.title} — ` : ""}{requirement.content}
        </li>)}</ol>
      </details>
      {preview.students.map(student => <div key={student.attempt_id} className="context-card">
        <p><strong>{student.name} · {student.student_number.toLocaleString("ar-EG")}</strong> · الإصدار السابق {student.from_plan_version.toLocaleString("ar-EG")}</p>
        <details><summary>متطلبات المحاولة السابقة ({student.before_requirements.length.toLocaleString("ar-EG")})</summary>
          <ol>{student.before_requirements.map(requirement => <li key={requirement.id}>
            {requirement.number.toLocaleString("ar-EG")}. {requirement.title ? `${requirement.title} — ` : ""}{requirement.content}
          </li>)}</ol>
        </details>
        <p>قبل: {coverageText(student.before)}؛ الناقص {student.before.missing_numbers.length.toLocaleString("ar-EG")}.</p>
        <p>بعد: {coverageText(student.after)}؛ الناقص {student.after.missing_numbers.length.toLocaleString("ar-EG")} ({student.after.missing_numbers.map(number => number.toLocaleString("ar-EG")).join("، ") || "لا يوجد"}).</p>
        {student.completion_decision ? <p>قرار إتمام سابق محفوظ، ولن يُسحب بهذا التطبيق.</p> : null}
      </div>)}
    </section> : null}
    <CenterHeaderActions>
      <Button form={`${formId}-form`} type="submit" variant="primary" busy={busy}
        disabled={busy || conflict || !targetId || !selected.length || reason.trim().length < 3}>
        {preview ? "تأكيد التطبيق على المختارين" : "معاينة أثر الإصدار"}
      </Button>
      {conflict ? <Button type="button" disabled={busy} onClick={() => {
        onReload(); setConflict(false); setPreview(null); setRequestId(newSubmissionId()); setError("");
        requestAnimationFrame(() => document.getElementById(`${formId}-version`)?.focus());
      }}>تحميل أحدث التقرير</Button> : null}
      <Button type="button" disabled={busy} onClick={() => draft ? setClosePrompt(true) : onClose()}>رجوع للتقرير</Button>
    </CenterHeaderActions>
    {closePrompt ? <ConfirmationDialog title="التخلي عن التطبيق" description="لديك اختيار أو معاينة لم تُعتمد. هل تريد الرجوع إلى التقرير؟"
      confirmLabel="الرجوع دون تطبيق" onCancel={() => setClosePrompt(false)} onConfirm={onClose} /> : null}
  </form>;
}
