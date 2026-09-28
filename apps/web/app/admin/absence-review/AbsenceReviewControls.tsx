"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { DataTable } from "@/components/DataTable";
import { InlineNotice } from "@/components/InlineNotice";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { centerRequest, responseMessage } from "@/lib/client-api";
import type { AbsenceContext, AbsenceOption } from "@/lib/server-context";

const kinds = ["courses", "stages", "levels", "study_groups"] as const;
const labels = { courses: "الكورس", stages: "المرحلة الدراسية", levels: "المستوى", study_groups: "المجموعة" };
type FilterKey = "branch_id" | "course_id" | "stage_id" | "level_id" | "group_id" | "view" | "q";

function ruleText(mode: string | null, limit: number | null): string {
  if (mode === "disabled") return "التنبيه معطل";
  if (limit === null) return "لم يُحدد حد الغياب";
  return `${limit.toLocaleString("ar-EG")} غياب ${mode === "total" ? "إجمالي" : "متتالٍ"}`;
}

export function AbsenceReviewControls({ context, filters }: { context: AbsenceContext; filters: Record<string, string> }) {
  const router = useRouter();
  const formId = useId();
  const [draft, setDraft] = useState<Record<FilterKey, string>>({
    branch_id: filters.branch_id ?? "", course_id: filters.course_id ?? "", stage_id: filters.stage_id ?? "",
    level_id: filters.level_id ?? "", group_id: filters.group_id ?? "", view: filters.view ?? "review", q: filters.q ?? "",
  });
  const [ruleKey, setRuleKey] = useState("");
  const [mode, setMode] = useState("inherit");
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [optionSearch, setOptionSearch] = useState("");
  const [extraOptions, setExtraOptions] = useState<AbsenceOption[]>([]);
  const [optionPage, setOptionPage] = useState(0);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionError, setOptionError] = useState("");
  const options = [...context.options, ...extraOptions.filter(option => !context.options.some(initial => initial.kind === option.kind && initial.id === option.id))];
  const selected = options.find(option => `${option.kind}:${option.id}` === ruleKey);
  const canManage = (branchId: number) => context.permissions.can_manage_center || context.permissions.branch_actions?.[String(branchId)]?.includes("curriculum.manage");
  const editable = options.filter(option => canManage(option.branch_id));
  const branches = Array.from(new Map(options.map(option => [option.branch_id, option.branch_name])).entries());

  function navigate(next: Record<FilterKey, string>) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) if (value) query.set(key, value);
    router.push(`/admin/absence-review${query.size ? `?${query}` : ""}`);
  }

  function selectRule(key: string) {
    const option = options.find(item => `${item.kind}:${item.id}` === key);
    setRuleKey(key); setMode(option?.absence_mode ?? "inherit"); setLimit(option?.absence_limit?.toString() ?? "");
    setError(""); setNotice(""); setConflict(false);
  }

  async function saveRule(event: FormEvent) {
    event.preventDefault();
    if (!selected || busy) return;
    if ((mode === "consecutive" || mode === "total") && (!/^[1-9]\d*$/.test(limit) || Number(limit) > 999)) {
      setError("أدخل حدًا بين ١ و٩٩٩ غيابًا."); return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`absence-rules/${selected.kind}/${selected.id}`, "PATCH", {
        mode, limit: mode === "consecutive" || mode === "total" ? Number(limit) : null,
        revision: selected.absence_revision,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setError("تغيرت القاعدة في جلسة أخرى. حدّث الصفحة ثم راجع القيمة الحالية."); }
        else setError(await responseMessage(response));
        return;
      }
      setNotice("حُفظت قاعدة الغياب وأُعيد حساب التقرير الحالي.");
      router.refresh();
    } catch {
      setError("تعذر الاتصال بالمركز. حاول مرة أخرى.");
    } finally { setBusy(false); }
  }

  function optionsFor(kind: AbsenceOption["kind"]) {
    return options.filter(option => option.kind === kind &&
      (!draft.branch_id || option.branch_id === Number(draft.branch_id)) &&
      (kind === "courses" || !draft.course_id || option.course_id === draft.course_id) &&
      (kind === "courses" || kind === "stages" || !draft.stage_id || option.stage_id === draft.stage_id) &&
      (kind !== "study_groups" || !draft.level_id || option.level_id === draft.level_id));
  }

  async function findOptions(page: number) {
    if (!optionSearch.trim() || loadingOptions) return;
    setLoadingOptions(true); setOptionError("");
    try {
      const query = new URLSearchParams({ q: optionSearch.trim(), page: String(page) });
      if (draft.branch_id) query.set("branch_id", draft.branch_id);
      const response = await centerRequest(`absence-options?${query}`, "GET");
      if (!response.ok) { setOptionError(await responseMessage(response)); return; }
      const result = (await response.json()) as { options: AbsenceOption[] };
      setExtraOptions(current => page === 1 ? result.options : [...current, ...result.options]);
      setOptionPage(result.options.length ? page : 0);
    } catch { setOptionError("تعذر البحث في النطاقات."); }
    finally { setLoadingOptions(false); }
  }

  const baseQuery = new URLSearchParams(Object.entries(filters).filter(([key, value]) => key !== "page" && value));
  const pageHref = (page: number) => { const query = new URLSearchParams(baseQuery); query.set("page", String(page)); return `/admin/absence-review?${query}`; };

  return <div className="form-stack" dir="rtl">
    <section className="data-panel form-stack" aria-labelledby="absence-filters-title">
      <h2 id="absence-filters-title">نطاق التقرير</h2>
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void findOptions(1); }}>
        <Field><FieldLabel htmlFor="absence-option-search">البحث في الكورسات والمراحل والمستويات والمجموعات</FieldLabel><Input id="absence-option-search" type="search" value={optionSearch} onChange={event => setOptionSearch(event.target.value)} /></Field>
        <Button type="submit" busy={loadingOptions} disabled={!optionSearch.trim()}>بحث في النطاقات</Button>
        {optionPage > 0 ? <Button onClick={() => void findOptions(optionPage + 1)} busy={loadingOptions}>تحميل نطاقات أخرى</Button> : null}
      </form>
      {optionError ? <InlineNotice tone="error">{optionError}</InlineNotice> : null}
      <form className="form-stack" onSubmit={event => { event.preventDefault(); navigate(draft); }}>
        <FieldGroup className="grid gap-3 md:grid-cols-3">
          <Field><FieldLabel htmlFor="absence-branch">الفرع</FieldLabel><NativeSelect id="absence-branch" value={draft.branch_id} onChange={event => setDraft({ branch_id: event.target.value, course_id: "", stage_id: "", level_id: "", group_id: "", view: draft.view, q: draft.q })}><NativeSelectOption value="">كل الفروع المصرح بها</NativeSelectOption>{branches.map(([id, name]) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}</NativeSelect></Field>
          {kinds.map((kind, index) => {
            const field = (["course_id", "stage_id", "level_id", "group_id"] as const)[index];
            const later = (["stage_id", "level_id", "group_id"] as const).slice(index);
            return <Field key={kind}><FieldLabel htmlFor={`absence-${kind}`}>{labels[kind]}</FieldLabel><NativeSelect id={`absence-${kind}`} value={draft[field]} onChange={event => setDraft(current => ({ ...current, [field]: event.target.value, ...Object.fromEntries(later.map(key => [key, ""])) }))}><NativeSelectOption value="">كل {labels[kind]}</NativeSelectOption>{optionsFor(kind).map(option => <NativeSelectOption key={option.id} value={option.id}>{option.name} · {option.branch_name}</NativeSelectOption>)}</NativeSelect></Field>;
          })}
          <Field><FieldLabel htmlFor="absence-view">عرض</FieldLabel><NativeSelect id="absence-view" value={draft.view} onChange={event => setDraft(current => ({ ...current, view: event.target.value }))}><NativeSelectOption value="review">المستوجبون للمراجعة</NativeSelectOption><NativeSelectOption value="all">جميع الطلاب الحاليين</NativeSelectOption></NativeSelect></Field>
        </FieldGroup>
        <Button type="submit" variant="primary">تطبيق النطاق</Button>
      </form>
    </section>

    {editable.length ? <section className="data-panel form-stack" aria-labelledby="absence-rule-title">
      <h2 id="absence-rule-title">قاعدة تنبيه الغياب</h2>
      <p className="muted">تُطبق قاعدة المجموعة أولًا، ثم المستوى، فالمرحلة، فالكورس. التعطيل الصريح يوقف التنبيه لهذا النطاق.</p>
      <form id={formId} className="form-stack" onSubmit={saveRule}>
        <FieldGroup className="grid gap-3 md:grid-cols-3">
          <Field><FieldLabel htmlFor="absence-rule-scope">النطاق المراد تعديله</FieldLabel><NativeSelect id="absence-rule-scope" value={ruleKey} onChange={event => selectRule(event.target.value)}><NativeSelectOption value="">اختر النطاق</NativeSelectOption>{editable.map(option => <NativeSelectOption key={`${option.kind}:${option.id}`} value={`${option.kind}:${option.id}`}>{labels[option.kind]}: {option.name} · {option.branch_name}</NativeSelectOption>)}</NativeSelect></Field>
          <Field><FieldLabel htmlFor="absence-rule-mode">نوع القاعدة</FieldLabel><NativeSelect id="absence-rule-mode" value={mode} disabled={!selected} onChange={event => { setMode(event.target.value); setError(""); }}><NativeSelectOption value="inherit" disabled={selected?.kind === "courses"}>موروثة</NativeSelectOption><NativeSelectOption value="consecutive">غياب متتالٍ</NativeSelectOption><NativeSelectOption value="total">غياب إجمالي</NativeSelectOption><NativeSelectOption value="disabled">تعطيل التنبيه</NativeSelectOption></NativeSelect></Field>
          <Field><FieldLabel htmlFor="absence-rule-limit">الحد</FieldLabel><Input id="absence-rule-limit" type="number" min={1} max={999} value={limit} disabled={!selected || mode === "inherit" || mode === "disabled"} onChange={event => setLimit(event.target.value)} aria-invalid={Boolean(error)} /><FieldDescription>من ١ إلى ٩٩٩ غيابًا عند اختيار المتتالي أو الإجمالي.</FieldDescription></Field>
        </FieldGroup>
        {selected ? <p className="muted">القيمة الحالية: {ruleText(selected.absence_mode, selected.absence_limit)}</p> : null}
        {error ? <InlineNotice tone="error">{error} {conflict ? <Button onClick={() => router.refresh()}>تحديث الصفحة</Button> : null}</InlineNotice> : null}
        {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      </form>
      <CenterHeaderActions><Button form={formId} type="submit" variant="primary" busy={busy} disabled={!selected || conflict}>حفظ قاعدة الغياب</Button></CenterHeaderActions>
    </section> : null}

    <DataTable id="absence-review" title="طلاب الغياب" description="العداد التشغيلي يخص فترة الارتباط الحالية؛ الغياب السابق محفوظ للتاريخ." rows={context.students}
      rowKey={row => row.id} searchText={row => `${row.student_name} ${row.student_number}`} emptyMessage="لا توجد حالات ضمن هذا النطاق."
      serverSearch={{ value: filters.q ?? "", onSearch: q => navigate({ ...draft, q }) }}
      serverPagination={{ page: context.pagination.page, hasMore: context.pagination.has_more, batchSize: 50, previousHref: pageHref(Math.max(1, context.pagination.page - 1)), nextHref: pageHref(context.pagination.page + 1) }}
      columns={[
        { key: "student", label: "الطالب", render: row => <Link href={`/admin/students/${row.student_id}`}>{row.student_name} · {row.student_number.toLocaleString("ar-EG")}</Link> },
        { key: "scope", label: "النطاق", render: row => <>{row.branch_name} · {row.course_name} · {row.stage_name} · {row.level_name} · {row.group_name}</> },
        { key: "rule", label: "القاعدة", render: row => ruleText(row.effective_mode, row.effective_limit) },
        { key: "current", label: "الغياب الحالي", render: row => <>{row.consecutive_absences.toLocaleString("ar-EG")} متتالٍ · {row.total_absences.toLocaleString("ar-EG")} إجمالي</> },
        { key: "history", label: "غياب فترات سابقة", render: row => row.historical_absences.toLocaleString("ar-EG") },
        { key: "status", label: "الحالة", render: row => row.needs_review ? "يحتاج مراجعة" : "دون الحد" },
      ]} />
  </div>;
}
