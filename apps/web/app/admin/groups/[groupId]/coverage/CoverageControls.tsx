"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions, CenterPageActions } from "@/components/CenterShell";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { DataTable } from "@/components/DataTable";
import { InlineNotice } from "@/components/InlineNotice";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";
import type { CoverageContext, CoverageRow } from "@/lib/groups";

type Impact = { attempt_id: string; name: string; student_number: number; before_threshold: number;
  after_threshold: number; covered_count: number; required_count: number; before_needed: number;
  after_needed: number; before_eligible: boolean; after_eligible: boolean };
type Preview = { target_threshold: number; required_count: number; students: Impact[]; preview_token: string };

export function CoverageControls({ context, search }: { context: CoverageContext; search: string }) {
  const router = useRouter();
  const reasonId = useId();
  const previewButton = useRef<HTMLButtonElement>(null);
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const navigationFocus = useRef<HTMLElement | null>(null);
  const [loadedContext, setLoadedContext] = useState(context);
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [requestId, setRequestId] = useState(newSubmissionId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null);
  if (loadedContext !== context) {
    setLoadedContext(context);
    setSelected([]);
    setPreview(null);
    setRequestId(newSubmissionId());
    setConflict(false);
  }
  const group = context.group;
  const canManage = context.permissions.can_manage_center || context.permissions.branch_actions?.[String(group.branch_id)]?.includes("curriculum.manage");
  const selectable = context.students.filter(row => row.completion_threshold !== group.completion_threshold);
  const selectedOnPage = selected.filter(id => selectable.some(row => row.attempt_id === id));
  const dirty = selectedOnPage.length > 0 || Boolean(preview) || reason.length > 0;
  const base = `/admin/groups/${group.id}/coverage`;
  const thresholdPath = `groups/${group.id}/completion-threshold`;
  function navigate(href: string) {
    if (busy) return;
    if (dirty) {
      navigationFocus.current = document.activeElement as HTMLElement;
      setPendingNavigation(href);
      return;
    }
    router.push(href);
  }
  function invalidatePreview() { setPreview(null); setRequestId(newSubmissionId()); setConflict(false); setError(""); setNotice(""); }
  function toggle(id: string, checked: boolean) {
    setSelected(current => checked ? [...current.filter(item => item !== id), id] : current.filter(item => item !== id));
    invalidatePreview();
  }
  async function reviewThreshold() {
    if (!selectedOnPage.length) { setError("اختر تسجيلًا واحدًا على الأقل من الجدول."); previewButton.current?.focus(); return; }
    if (reason.trim().length < 3) { setError("أدخل سبب التطبيق بثلاثة أحرف على الأقل."); reasonInput.current?.focus(); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`${thresholdPath}/preview`, "POST", { attempt_ids: selectedOnPage, reason: reason.trim() });
      if (!response.ok) { setError(await responseMessage(response)); return; }
      setPreview(await response.json() as Preview);
    } catch { setError("تعذرت معاينة أثر النسبة. حاول مرة أخرى."); }
    finally { setBusy(false); }
  }
  async function applyThreshold() {
    if (!preview || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(thresholdPath, "POST", { attempt_ids: selectedOnPage,
        reason: reason.trim(), preview_token: preview.preview_token, request_id: requestId });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setPreview(null); setRequestId(newSubmissionId()); }
        setError(await responseMessage(response)); return;
      }
      setSelected([]); setReason(""); setPreview(null); setRequestId(newSubmissionId());
      setNotice("تم تطبيق نسبة الإتمام على التسجيلات المختارة وحفظ قرارها في سجل التدقيق.");
      router.refresh();
      previewButton.current?.focus();
    } catch { setError("تعذر حفظ القرار. يمكنك إعادة المحاولة بنفس المعاينة."); }
    finally { setBusy(false); }
  }
  const href = (page: number, q = search) => {
    const params = new URLSearchParams();
    if (page > 1) params.set("page", String(page));
    if (q) params.set("q", q);
    return `${base}${params.size ? `?${params}` : ""}`;
  };
  const label = (numbers: number[]) => numbers.length ? numbers.map(number => {
    const requirement = group.requirements.find(item => item.number === number);
    return `${number.toLocaleString("ar-EG")} · ${requirement?.title || requirement?.content || "محاضرة مطلوبة"}`;
  }).join("، ") : "لا يوجد";
  const result = (row: CoverageRow) => {
    if (row.student_status === "suspended") return "تحتاج مراجعة: الطالب موقوف";
    if (row.attempt_status === "withdrawn") return "تحتاج مراجعة: المحاولة منسحب منها";
    if (row.eligible) return row.open_numbers.length ? "مؤهل مبدئيًا — حضور مفتوح" : "بلغ الحد — يحتاج اعتمادًا صريحًا";
    return row.open_numbers.length ? "ناقص — النسبة مبدئية" : "ناقص";
  };

  return <>
    <UnsavedChangesGuard dirty={dirty || busy} guardHistory blockDiscard={busy}
      blockDiscardTitle="انتظر نتيجة اعتماد النسبة"
      blockDiscardDescription="طلب اعتماد النسبة قيد التنفيذ. ابق في الصفحة حتى تظهر نتيجته؛ المغادرة الآن قد تترك حالة القرار غير واضحة." />
    {pendingNavigation ? <ConfirmationDialog title="مغادرة دون تطبيق" description="اخترت تسجيلات أو أدخلت سببًا لتغيير نسبة الإتمام ولم تعتمد القرار. هل تريد الانتقال والتخلي عن المعاينة؟" confirmLabel="الانتقال دون تطبيق" onCancel={() => { setPendingNavigation(null); requestAnimationFrame(() => navigationFocus.current?.focus()); }} onConfirm={() => { const next = pendingNavigation; setPendingNavigation(null); setSelected([]); setReason(""); setPreview(null); router.push(next); }} /> : null}
    <CenterPageActions context={context} actions={<><Link href={`/admin/groups/${group.id}/sessions`}>جدول محاضرات المجموعة</Link><Link href="/admin/groups">العودة للمجموعات</Link></>} />
    <p className="muted">{group.name} · المطلوب {group.required_count.toLocaleString("ar-EG")} محاضرة · حد التسجيلات الجديدة {group.completion_threshold.toLocaleString("ar-EG")}%.</p>
    <p className="muted">المحاضرات السابقة لانضمام الطالب تبقى ضمن المطلوب، لكنها ليست غيابًا عليه. النسبة هنا لتغطية المحتوى فقط؛ بلوغ الحد لا يعتمد إتمام الدراسة تلقائيًا.</p>
    {canManage ? <section className="space-y-3" aria-label="تطبيق نسبة الإتمام على تسجيلات قائمة">
      <h2 className="text-lg font-semibold">تطبيق النسبة على تسجيلات قائمة</h2>
      <p className="muted">تغيير نسبة المجموعة يطبّق تلقائيًا على التسجيلات الجديدة. اختر من الجدول التسجيلات الحالية التي تريد تحديثها؛ ستبقى بقية التسجيلات على نسبتها المثبتة.</p>
      <Field>
        <FieldLabel htmlFor={reasonId}>سبب التطبيق</FieldLabel>
        <Textarea id={reasonId} ref={reasonInput} value={reason} maxLength={1000} onChange={event => { setReason(event.target.value); invalidatePreview(); }} placeholder="سبب تطبيق النسبة الجديدة على التسجيلات المختارة" />
        <FieldDescription>المعاينة تعرض الحد القديم والجديد وأثرهما قبل الاعتماد.</FieldDescription>
      </Field>
      {error ? <InlineNotice tone="error">{error}{conflict ? " حدّث الصفحة ثم أعد المعاينة." : ""}</InlineNotice> : null}
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      {preview ? <div className="space-y-2" role="status">
        <p><strong>معاينة التطبيق:</strong> {preview.students.length.toLocaleString("ar-EG")} تسجيلات · الحد الجديد {preview.target_threshold.toLocaleString("ar-EG")}٪ · المطلوب {preview.required_count.toLocaleString("ar-EG")} محاضرات.</p>
        <ul className="list-disc ps-6">{preview.students.map(student => <li key={student.attempt_id}>
          {student.name} · {student.student_number.toLocaleString("ar-EG")}: {student.before_threshold.toLocaleString("ar-EG")}٪ ({student.before_needed.toLocaleString("ar-EG")} محاضرات) ← {student.after_threshold.toLocaleString("ar-EG")}٪ ({student.after_needed.toLocaleString("ar-EG")} محاضرات)؛ الأهلية {student.before_eligible ? "مستوفٍ" : "غير مستوفٍ"} ← {student.after_eligible ? "مستوفٍ" : "غير مستوفٍ"}.
        </li>)}</ul>
        <p className="muted">تُراجع بيانات المجموعة والحضور والصلاحية مجددًا عند الاعتماد. بلوغ الحد لا يعتمد إتمام الدراسة تلقائيًا.</p>
      </div> : null}
      <CenterHeaderActions>
        <Button ref={previewButton} onClick={reviewThreshold} busy={busy} disabled={!selectedOnPage.length}>معاينة أثر النسبة</Button>
        {preview ? <Button variant="primary" onClick={applyThreshold} busy={busy}>اعتماد التطبيق على المختارين</Button> : null}
        {selectedOnPage.length ? <Button onClick={() => { setSelected([]); invalidatePreview(); previewButton.current?.focus(); }} disabled={busy}>إلغاء الاختيار</Button> : null}
      </CenterHeaderActions>
    </section> : null}
    <DataTable id="study-coverage" title="تقرير أهلية إتمام الدراسة" description="المحتسب من محاضرات الخطة مرة واحدة. الحضور في محاضرة مفتوحة مبدئي حتى الإغلاق." rows={context.students}
      rowKey={row => row.attempt_id} searchText={row => `${row.name} ${row.student_number}`} emptyMessage="لا توجد محاولات دراسة مطابقة في هذه المجموعة."
      serverSearch={{ value: search, onSearch: value => navigate(href(1, value)) }}
      serverPagination={{ page: context.pagination.page, hasMore: context.pagination.has_more, batchSize: 20,
        previousHref: href(context.pagination.page - 1), nextHref: href(context.pagination.page + 1), onNavigate: navigate }}
      columns={[
        ...(canManage ? [{ key: "select", label: "اختيار", render: (row: CoverageRow) => <Checkbox
          checked={selectedOnPage.includes(row.attempt_id)} disabled={busy || row.completion_threshold === group.completion_threshold}
          onCheckedChange={checked => toggle(row.attempt_id, checked === true)}
          aria-label={`اختيار تسجيل ${row.name} لتطبيق نسبة الإتمام`} /> }] : []),
        { key: "student", label: "الطالب", render: row => <Link href={`/admin/students/${row.student_id}`}>{row.name} · {row.student_number.toLocaleString("ar-EG")}</Link> },
        { key: "coverage", label: "التغطية", render: row => `${row.covered_count.toLocaleString("ar-EG")}/${row.required_count.toLocaleString("ar-EG")} · ${row.percentage.toLocaleString("ar-EG")}%` },
        { key: "missing", label: "الناقص", render: row => row.missing_numbers.length.toLocaleString("ar-EG") },
        { key: "result", label: "أهلية الإتمام", render: result },
      ]}
      expanded={row => <div className="space-y-2"><p><strong>المستوفى:</strong> {label(row.covered_numbers)}</p><p><strong>الناقص:</strong> {label(row.missing_numbers)}</p>
        <p>حد هذه المحاولة: {row.completion_threshold.toLocaleString("ar-EG")}% ({Math.ceil(row.required_count * row.completion_threshold / 100).toLocaleString("ar-EG")} محاضرة كاملة على الأقل).</p>
        {row.open_numbers.length ? <p role="status"><strong>حضور مبدئي في محاضرات مفتوحة:</strong> {label(row.open_numbers)}. قد تتغير النسبة عند التراجع، ولا يجوز اعتماد الإتمام حتى الإغلاق وإعادة المراجعة.</p> : null}
        <p className="muted">تاريخ الانضمام: {row.joined_on} · حالة محاولة الدراسة: {row.attempt_status === "withdrawn" ? "منسحب" : row.attempt_status === "completed" ? "مكتملة" : "نشطة"}</p>
      </div>} />
  </>;
}
