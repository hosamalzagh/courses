"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { InlineNotice } from "@/components/InlineNotice";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { centerRequest, responseMessage } from "@/lib/client-api";
import type { AbsenceContext, AbsenceStudent } from "@/lib/server-context";

type BatchItem = {
  attempt_id: string; student_id: string; student_name: string; student_number: number;
  branch_id: number; status: "pending" | "moved" | "skipped"; result_reason: string | null; waitlist_id: string | null;
};
type BatchResult = {
  batch: { id: string; selection_mode: "selected" | "all"; scope: Record<string, string>; entered_on: string;
    reason: string; total: number; pending: number; moved: number; skipped: number };
  items: BatchItem[];
  pagination: { page: number; has_more: boolean };
};

function todayInCairo() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export function AbsenceBulkWaitlist({ context, filters, selected, onSelectionChange }: {
  context: AbsenceContext; filters: Record<string, string>; selected: string[]; onSelectionChange: (ids: string[]) => void;
}) {
  const [mode, setMode] = useState<"selected" | "all">("selected");
  const formId = useId();
  const [enteredOn, setEnteredOn] = useState(todayInCairo);
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<BatchResult | null>(null);
  const [busy, setBusy] = useState<"preview" | "execute" | "load" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const canManage = (branchId: number) => context.permissions.can_manage_center ||
    context.permissions.branch_actions?.[String(branchId)]?.includes("enrollment.manage");
  const selectable = context.students.filter(row => row.student_status === "active" && canManage(row.branch_id));
  const selectableIds = selectable.map(row => row.id);
  const allPageSelected = selectableIds.length > 0 && selectableIds.every(id => selected.includes(id));
  const scopeDescription = (scope: Record<string, string>) => [
    scope.branch_id ? context.branches.find(branch => branch.id === Number(scope.branch_id))?.name ?? `فرع #${scope.branch_id}` : "الفروع المصرح بها",
    ...(["course_id", "stage_id", "level_id", "group_id"] as const).flatMap(key => {
      const id = scope[key];
      return id ? [context.options.find(option => option.id === id)?.name ?? id] : [];
    }),
    scope.view === "all" ? "جميع الطلاب الحاليين" : "المستوجبون للمراجعة",
    scope.q ? `بحث: ${scope.q}` : "",
  ].filter(Boolean).join(" / ");
  const scopeParts = scopeDescription(filters);

  async function loadBatch(id: string, page = 1) {
    setBusy("load"); setError("");
    try {
      const response = await centerRequest(`absence-review/waitlist-batches/${id}?page=${page}`, "GET");
      if (!response.ok) { setError(await responseMessage(response)); errorRef.current?.focus(); return; }
      setResult(await response.json() as BatchResult);
    } catch { setError("تعذر تحميل المعاينة. حاول مرة أخرى."); errorRef.current?.focus(); }
    finally { setBusy(null); }
  }

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("bulk_batch");
    if (id && /^[0-9a-f-]{36}$/i.test(id)) queueMicrotask(() => void loadBatch(id));
  }, []);

  async function preview(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (mode === "selected" && selected.length === 0) { setError("اختر طالبًا واحدًا على الأقل من الجدول."); errorRef.current?.focus(); return; }
    if (!reason.trim()) { setError("أدخل سبب النقل إلى الانتظار."); reasonRef.current?.focus(); return; }
    setBusy("preview"); setError(""); setNotice("");
    try {
      const response = await centerRequest("absence-review/waitlist-batches", "POST", {
        selection_mode: mode, ...(mode === "selected" ? { attempt_ids: selected } : {}),
        ...Object.fromEntries(Object.entries(filters).filter(([key, value]) =>
          ["branch_id", "course_id", "stage_id", "level_id", "group_id", "view", "q"].includes(key) && value)),
        entered_on: enteredOn, reason: reason.trim(),
      });
      if (!response.ok) { setError(await responseMessage(response)); errorRef.current?.focus(); return; }
      const next = await response.json() as BatchResult;
      setResult(next);
      const url = new URL(window.location.href);
      url.searchParams.set("bulk_batch", next.batch.id);
      window.history.replaceState(window.history.state, "", url);
      requestAnimationFrame(() => previewHeadingRef.current?.focus());
    } catch { setError("تعذر إنشاء المعاينة. حاول مرة أخرى."); errorRef.current?.focus(); }
    finally { setBusy(null); }
  }

  async function execute() {
    if (!result || busy || result.batch.pending === 0) return;
    setBusy("execute"); setError(""); setNotice("");
    let current = result;
    try {
      while (current.batch.pending > 0) {
        const response = await centerRequest(`absence-review/waitlist-batches/${current.batch.id}/execute`, "POST");
        if (!response.ok) { setError(await responseMessage(response)); errorRef.current?.focus(); return; }
        current = await response.json() as BatchResult;
        setResult(current);
      }
      setNotice(current.batch.skipped > 0
        ? `اكتمل النقل جزئيًا: نُقل ${current.batch.moved.toLocaleString("ar-EG")} واستُبعد ${current.batch.skipped.toLocaleString("ar-EG")}. راجع سبب كل حالة أدناه.`
        : `اكتمل نقل ${current.batch.moved.toLocaleString("ar-EG")} طالب إلى الانتظار.`);
    } catch { setError("انقطع الاتصال أثناء التنفيذ. ما تم حفظه ظاهر أدناه؛ اضغط استكمال التنفيذ لإعادة الفحص دون تكرار النقل."); errorRef.current?.focus(); }
    finally { setBusy(null); }
  }

  const resultScope = result ? scopeDescription(result.batch.scope) : "";
  const pageStudents = selectableIds.filter(id => selected.includes(id));

  return <section className="data-panel form-stack" aria-labelledby="absence-bulk-title">
    <h2 id="absence-bulk-title">نقل الطلاب إلى الانتظار من تقرير الغياب</h2>
    <p className="muted">اختر الطلاب من الجدول أو كل المؤهلين في نطاق التقرير المطبق. المعاينة لا تنقل أحدًا؛ التنفيذ يعيد فحص كل حالة ويحفظ نتيجتها.</p>
    <form id={formId} className="form-stack" onSubmit={preview}>
      <FieldGroup className="grid gap-3 md:grid-cols-3">
        <Field><FieldLabel htmlFor="bulk-selection-mode">طريقة الاختيار</FieldLabel>
          <NativeSelect id="bulk-selection-mode" value={mode} disabled={Boolean(busy)} onChange={event => setMode(event.target.value as "selected" | "all")}>
            <NativeSelectOption value="selected">طلاب محددون ({selected.length.toLocaleString("ar-EG")})</NativeSelectOption>
            <NativeSelectOption value="all">كل المؤهلين في نطاق التقرير</NativeSelectOption>
          </NativeSelect>
          <FieldDescription>الاختيار اليدوي يشمل الطلاب المحددين من الدفعة المعروضة. اختيار الكل يشمل كل صفحات النطاق.</FieldDescription>
        </Field>
        <Field><FieldLabel htmlFor="bulk-entered-on">تاريخ بدء الانتظار</FieldLabel>
          <Input id="bulk-entered-on" type="date" value={enteredOn} max={todayInCairo()} disabled={Boolean(busy)}
            onChange={event => setEnteredOn(event.target.value)} required />
        </Field>
        <Field><FieldLabel htmlFor="bulk-reason">سبب النقل</FieldLabel>
          <Textarea ref={reasonRef} id="bulk-reason" value={reason} maxLength={2000} disabled={Boolean(busy)}
            onChange={event => setReason(event.target.value)} required />
        </Field>
      </FieldGroup>
      <p className="muted">النطاق الحالي: {scopeParts}</p>
      {mode === "selected" && selectableIds.length > 0 ? <FieldLabel className="flex items-center gap-2">
        <Checkbox checked={allPageSelected} disabled={Boolean(busy)} onCheckedChange={checked =>
          onSelectionChange(checked ? [...new Set([...selected, ...selectableIds])] : selected.filter(id => !selectableIds.includes(id)))} />
        تحديد كل الطلاب القابلين للاختيار في الدفعة المحمّلة ({selectableIds.length.toLocaleString("ar-EG")})
      </FieldLabel> : null}
      {mode === "selected" && pageStudents.length > 0 ? <p className="muted">المحددون في الدفعة: {pageStudents.length.toLocaleString("ar-EG")}</p> : null}
      <CenterHeaderActions><Button form={formId} type="submit" variant="primary" busy={busy === "preview"} disabled={Boolean(busy) || (mode === "selected" && selected.length === 0)}>معاينة النقل</Button></CenterHeaderActions>
    </form>
    {error ? <div ref={errorRef} tabIndex={-1}><InlineNotice tone="error">{error}</InlineNotice></div> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {result ? <div className="form-stack" aria-live="polite">
      <h3 ref={previewHeadingRef} tabIndex={-1}>معاينة الدفعة ونتيجتها</h3>
      <p>النطاق: {resultScope} · السبب: {result.batch.reason} · تاريخ الانتظار: {result.batch.entered_on}</p>
      <p>الإجمالي: {result.batch.total.toLocaleString("ar-EG")} · نُقل: {result.batch.moved.toLocaleString("ar-EG")} · استُبعد: {result.batch.skipped.toLocaleString("ar-EG")} · ينتظر التنفيذ: {result.batch.pending.toLocaleString("ar-EG")}</p>
      <div className="table-scroll" role="region" aria-label="نتائج النقل الجماعي" tabIndex={0}>
        <Table><TableHeader><TableRow><TableHead>الطالب</TableHead><TableHead>النتيجة</TableHead><TableHead>التفسير</TableHead></TableRow></TableHeader>
          <TableBody>{result.items.map(item => <TableRow key={item.attempt_id}>
            <TableCell><Link href={`/admin/students/${item.student_id}`}>{item.student_name} · {item.student_number.toLocaleString("ar-EG")}</Link></TableCell>
            <TableCell>{item.status === "pending" ? "في المعاينة" : item.status === "moved" ? "نُقل إلى الانتظار" : "استُبعد"}</TableCell>
            <TableCell>{item.result_reason ?? "—"}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </div>
      <CenterHeaderActions>
        {result.pagination.page > 1 ? <Button disabled={Boolean(busy)} onClick={() => void loadBatch(result.batch.id, result.pagination.page - 1)}>السابق</Button> : null}
        {result.pagination.has_more ? <Button disabled={Boolean(busy)} onClick={() => void loadBatch(result.batch.id, result.pagination.page + 1)}>التالي</Button> : null}
        {result.batch.pending > 0 ? <Button variant="primary" busy={busy === "execute"} disabled={Boolean(busy)} onClick={() => void execute()}>
          {result.batch.moved || result.batch.skipped ? "استكمال التنفيذ" : "تأكيد نقل المؤهلين"}
        </Button> : null}
      </CenterHeaderActions>
    </div> : null}
  </section>;
}

export function AbsenceSelectionCell({ row, selected, onToggle }: { row: AbsenceStudent; selected: boolean; onToggle: (id: string, checked: boolean) => void }) {
  return <Checkbox checked={selected} onCheckedChange={checked => onToggle(row.id, Boolean(checked))}
    aria-label={`اختيار ${row.student_name} للنقل إلى الانتظار`} />;
}
