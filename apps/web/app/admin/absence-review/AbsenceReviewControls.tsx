"use client";

import { useId, useRef, useState, type FormEvent, type SetStateAction } from "react";
import { useWorkspaceRouter as useRouter } from "@/components/WorkspaceNavigation";
import { AbsenceBulkWaitlist, AbsenceSelectionCell, MAX_BULK_SELECTION } from "./AbsenceBulkWaitlist";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { DataTable } from "@/components/DataTable";
import { InlineNotice } from "@/components/InlineNotice";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { centerRequest, responseMessage } from "@/lib/client-api";
import type { AbsenceContext, AbsenceOption, Branch } from "@/lib/server-context";

const kinds = ["courses", "stages", "levels", "study_groups"] as const;
const labels = { courses: "الكورس", stages: "المرحلة الدراسية", levels: "المستوى", study_groups: "المجموعة" };
type FilterKey = "branch_id" | "course_id" | "stage_id" | "level_id" | "group_id" | "view" | "q";

function ruleText(mode: string | null, limit: number | null): string {
  if (mode === null) return "موروثة";
  if (mode === "disabled") return "التنبيه معطل";
  if (limit === null) return "لم يُحدد حد الغياب";
  return `${limit.toLocaleString("ar-EG")} غياب ${mode === "total" ? "إجمالي" : "متتالٍ"}`;
}

function scopePath(option: AbsenceOption): string {
  const parents = option.kind === "courses" ? [] : option.kind === "stages" ? [option.course_name]
    : option.kind === "levels" ? [option.course_name, option.stage_name]
    : [option.course_name, option.stage_name, option.level_name];
  return [option.branch_name, ...parents, option.name].filter(Boolean).join(" / ");
}

export function AbsenceReviewControls({ context, filters, initialBatchId }: { context: AbsenceContext; filters: Record<string, string>; initialBatchId: string | null }) {
  const router = useRouter();
  const formId = useId();
  const optionSearchFormId = useId();
  const filtersFormId = useId();
  const ruleSelect = useRef<HTMLSelectElement>(null);
  const limitInput = useRef<HTMLInputElement>(null);
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
  const [extraBranches, setExtraBranches] = useState<Branch[]>([]);
  const [optionPage, setOptionPage] = useState(0);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionError, setOptionError] = useState("");
  const [pendingNavigation, setPendingNavigation] = useState<Record<FilterKey, string> | null>(null);
  const [pendingRule, setPendingRule] = useState<string | null>(null);
  const selectionScope = JSON.stringify(([
    "branch_id", "course_id", "stage_id", "level_id", "group_id", "view", "q",
  ] as const).map(key => filters[key] ?? ""));
  const [selection, setSelection] = useState({ scope: selectionScope, ids: [] as string[] });
  const [bulkDraftDirty, setBulkDraftDirty] = useState(false);
  const [batchId, setBatchId] = useState(initialBatchId);
  const selectedAttemptIds = selection.scope === selectionScope ? selection.ids : [];
  function setSelectedAttemptIds(next: SetStateAction<string[]>) {
    setSelection(current => {
      const ids = current.scope === selectionScope ? current.ids : [];
      const requested = typeof next === "function" ? next(ids) : next;
      return { scope: selectionScope, ids: requested.slice(0, MAX_BULK_SELECTION) };
    });
  }
  const enrollmentScopeId = (["group_id", "level_id", "stage_id", "course_id"] as const)
    .map(key => filters[key]).find(Boolean);
  const enrollmentScope = context.options.find(option => option.id === enrollmentScopeId);
  const enrollmentBranchId = filters.branch_id ? Number(filters.branch_id) : enrollmentScope?.branch_id;
  const canManageEnrollment = (branchId: number) => context.permissions.can_manage_center ||
    context.permissions.branch_actions?.[String(branchId)]?.includes("enrollment.manage");
  const canBulkWaitlist = enrollmentBranchId !== undefined
    ? canManageEnrollment(enrollmentBranchId)
    : context.permissions.can_manage_center || Object.values(context.permissions.branch_actions ?? {})
      .some(actions => actions.includes("enrollment.manage"));
  const options = [...context.options, ...extraOptions.filter(option => !context.options.some(initial => initial.kind === option.kind && initial.id === option.id))];
  const pathCounts = new Map<string, number>();
  for (const option of options) {
    const path = scopePath(option);
    pathCounts.set(path, (pathCounts.get(path) ?? 0) + 1);
  }
  const scopeLabel = (option: AbsenceOption) => {
    const path = scopePath(option);
    return (pathCounts.get(path) ?? 0) > 1 ? `${path} · ${option.id}` : path;
  };
  const [savedRules, setSavedRules] = useState<Record<string, Pick<AbsenceOption, "absence_mode" | "absence_limit" | "absence_revision">>>({});
  const selectedOption = options.find(option => `${option.kind}:${option.id}` === ruleKey);
  const localRule = savedRules[ruleKey];
  const selected = selectedOption && localRule && localRule.absence_revision >= selectedOption.absence_revision
    ? { ...selectedOption, ...localRule } : selectedOption;
  const proposedLimit = mode === "consecutive" || mode === "total" ? Number(limit) || null : null;
  const dirty = Boolean(selected && (mode !== (selected.absence_mode ?? "inherit") || proposedLimit !== selected.absence_limit));
  const canManage = (branchId: number) => context.permissions.can_manage_center || context.permissions.branch_actions?.[String(branchId)]?.includes("curriculum.manage");
  const editable = options.filter(option => canManage(option.branch_id));
  const branches = Array.from(new Map<number, Branch>([
    ...options.map(option => [option.branch_id, { id: option.branch_id, name: option.branch_name, slug: "", address: null }] as const),
    ...context.branches.map(branch => [branch.id, branch] as const),
    ...extraBranches.map(branch => [branch.id, branch] as const),
  ]).values());
  const branchNameCounts = new Map<string, number>();
  for (const branch of branches) branchNameCounts.set(branch.name, (branchNameCounts.get(branch.name) ?? 0) + 1);

  function navigate(next: Record<FilterKey, string>) {
    if (dirty || bulkDraftDirty) { setPendingNavigation(next); return; }
    performNavigation(next);
  }

  function performNavigation(next: Record<FilterKey, string>) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) if (value) query.set(key, value);
    router.push(`/admin/absence-review${query.size ? `?${query}` : ""}`);
  }

  function selectRule(key: string) {
    if (key !== ruleKey && dirty) { setPendingRule(key); return; }
    selectRuleNow(key);
  }

  function selectRuleNow(key: string) {
    const option = options.find(item => `${item.kind}:${item.id}` === key);
    setRuleKey(key); setMode(option?.absence_mode ?? "inherit"); setLimit(option?.absence_limit?.toString() ?? "");
    setError(""); setNotice(""); setConflict(false);
  }

  function cancelRule() {
    setMode(selected?.absence_mode ?? "inherit"); setLimit(selected?.absence_limit?.toString() ?? "");
    setError(""); setNotice(""); setConflict(false);
    ruleSelect.current?.focus();
  }

  async function saveRule(event: FormEvent) {
    event.preventDefault();
    if (!selected || busy) return;
    if ((mode === "consecutive" || mode === "total") && (!/^[1-9]\d*$/.test(limit) || Number(limit) > 999)) {
      setError("أدخل حدًا بين ١ و٩٩٩ غيابًا."); limitInput.current?.focus(); return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`absence-rules/${selected.kind}/${selected.id}`, "PATCH", {
        mode, limit: mode === "consecutive" || mode === "total" ? Number(limit) : null,
        revision: selected.absence_revision,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setError("تغيرت القاعدة في جلسة أخرى. حدّث الصفحة ثم راجع القيمة الحالية."); }
        else { setError(await responseMessage(response)); if (response.status === 422) limitInput.current?.focus(); }
        return;
      }
      const result = (await response.json()) as { rule: { mode: AbsenceOption["absence_mode"]; limit: number | null; revision: number } };
      setSavedRules(current => ({ ...current, [ruleKey]: {
        absence_mode: result.rule.mode, absence_limit: result.rule.limit, absence_revision: result.rule.revision,
      } }));
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
      const result = (await response.json()) as { options: AbsenceOption[]; branches: Branch[] };
      setExtraOptions(current => [...new Map([...current, ...result.options]
        .map(option => [`${option.kind}:${option.id}`, option])).values()]);
      setExtraBranches(current => [...new Map([...current, ...result.branches]
        .map(branch => [branch.id, branch])).values()]);
      setOptionPage(result.options.length || result.branches.length ? page : 0);
    } catch { setOptionError("تعذر البحث في النطاقات."); }
    finally { setLoadingOptions(false); }
  }

  const baseQuery = new URLSearchParams(Object.entries(filters).filter(([key, value]) => key !== "page" && value));
  const pageHref = (page: number) => { const query = new URLSearchParams(baseQuery); query.set("page", String(page)); if (batchId) query.set("bulk_batch", batchId); return `/admin/absence-review?${query}`; };

  return <div className="form-stack" dir="rtl">
    <UnsavedChangesGuard dirty={dirty || bulkDraftDirty} guardHistory />
    {pendingNavigation ? <ConfirmationDialog title="مغادرة دون حفظ" description="لديك تعديل في قاعدة الغياب أو مسودة نقل لم تُحفظ. هل تريد تطبيق نطاق آخر دون حفظ التغيير؟" confirmLabel="تطبيق النطاق دون حفظ" onCancel={() => setPendingNavigation(null)} onConfirm={() => { const next = pendingNavigation; setPendingNavigation(null); performNavigation(next); }} /> : null}
    {pendingRule !== null ? <ConfirmationDialog title="تغيير النطاق دون حفظ" description="غيّرت قاعدة الغياب ولم تحفظها. هل تريد فتح قاعدة أخرى دون حفظ التغيير؟" confirmLabel="فتح قاعدة أخرى" onCancel={() => { setPendingRule(null); ruleSelect.current?.focus(); }} onConfirm={() => { const next = pendingRule; setPendingRule(null); selectRuleNow(next); ruleSelect.current?.focus(); }} /> : null}
    <section className="data-panel form-stack" aria-labelledby="absence-filters-title">
      <h2 id="absence-filters-title">نطاق التقرير</h2>
      <form id={optionSearchFormId} className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void findOptions(1); }}>
        <Field><FieldLabel htmlFor="absence-option-search">البحث في الفروع والكورسات والمراحل والمستويات والمجموعات</FieldLabel><Input id="absence-option-search" type="search" value={optionSearch} onChange={event => setOptionSearch(event.target.value)} /></Field>
      </form>
      {optionError ? <InlineNotice tone="error">{optionError}</InlineNotice> : null}
      <form id={filtersFormId} className="form-stack" onSubmit={event => { event.preventDefault(); navigate(draft); }}>
        <FieldGroup className="grid gap-3 md:grid-cols-3">
          <Field><FieldLabel htmlFor="absence-branch">الفرع</FieldLabel><NativeSelect id="absence-branch" value={draft.branch_id} onChange={event => setDraft({ branch_id: event.target.value, course_id: "", stage_id: "", level_id: "", group_id: "", view: draft.view, q: draft.q })}><NativeSelectOption value="">كل الفروع المصرح بها</NativeSelectOption>{branches.map(branch => <NativeSelectOption key={branch.id} value={branch.id}>{branch.name}{(branchNameCounts.get(branch.name) ?? 0) > 1 ? ` · ${branch.slug || `#${branch.id}`}` : ""}</NativeSelectOption>)}</NativeSelect></Field>
          {kinds.map((kind, index) => {
            const field = (["course_id", "stage_id", "level_id", "group_id"] as const)[index];
            const later = (["stage_id", "level_id", "group_id"] as const).slice(index);
            return <Field key={kind}><FieldLabel htmlFor={`absence-${kind}`}>{labels[kind]}</FieldLabel><NativeSelect id={`absence-${kind}`} value={draft[field]} onChange={event => setDraft(current => ({ ...current, [field]: event.target.value, ...Object.fromEntries(later.map(key => [key, ""])) }))}><NativeSelectOption value="">كل {labels[kind]}</NativeSelectOption>{optionsFor(kind).map(option => <NativeSelectOption key={option.id} value={option.id}>{scopeLabel(option)}</NativeSelectOption>)}</NativeSelect></Field>;
          })}
          <Field><FieldLabel htmlFor="absence-view">عرض</FieldLabel><NativeSelect id="absence-view" value={draft.view} onChange={event => setDraft(current => ({ ...current, view: event.target.value }))}><NativeSelectOption value="review">المستوجبون للمراجعة</NativeSelectOption><NativeSelectOption value="all">جميع الطلاب الحاليين</NativeSelectOption></NativeSelect></Field>
        </FieldGroup>
      </form>
      <CenterHeaderActions>
        <Button form={filtersFormId} type="submit" variant="primary">تطبيق النطاق</Button>
        <Button form={optionSearchFormId} type="submit" busy={loadingOptions} disabled={!optionSearch.trim()}>بحث في النطاقات</Button>
        {optionPage > 0 ? <Button onClick={() => void findOptions(optionPage + 1)} busy={loadingOptions}>تحميل نطاقات أخرى</Button> : null}
      </CenterHeaderActions>
    </section>

    {editable.length ? <section className="data-panel form-stack" aria-labelledby="absence-rule-title">
      <h2 id="absence-rule-title">قاعدة تنبيه الغياب</h2>
      <p className="muted">تُطبق قاعدة المجموعة أولًا، ثم المستوى، فالمرحلة، فالكورس. التعطيل الصريح يوقف التنبيه لهذا النطاق.</p>
      <form id={formId} className="form-stack" onSubmit={saveRule}>
        <FieldGroup className="grid gap-3 md:grid-cols-3">
          <Field><FieldLabel htmlFor="absence-rule-scope">النطاق المراد تعديله</FieldLabel><NativeSelect ref={ruleSelect} id="absence-rule-scope" value={ruleKey} onChange={event => selectRule(event.target.value)}><NativeSelectOption value="">اختر النطاق</NativeSelectOption>{editable.map(option => <NativeSelectOption key={`${option.kind}:${option.id}`} value={`${option.kind}:${option.id}`}>{labels[option.kind]}: {scopeLabel(option)}</NativeSelectOption>)}</NativeSelect></Field>
          <Field><FieldLabel htmlFor="absence-rule-mode">نوع القاعدة</FieldLabel><NativeSelect id="absence-rule-mode" value={mode} disabled={!selected} onChange={event => { setMode(event.target.value); setError(""); }}><NativeSelectOption value="inherit" disabled={selected?.kind === "courses"}>موروثة</NativeSelectOption><NativeSelectOption value="consecutive">غياب متتالٍ</NativeSelectOption><NativeSelectOption value="total">غياب إجمالي</NativeSelectOption><NativeSelectOption value="disabled">تعطيل التنبيه</NativeSelectOption></NativeSelect></Field>
          <Field><FieldLabel htmlFor="absence-rule-limit">الحد</FieldLabel><Input ref={limitInput} id="absence-rule-limit" type="number" min={1} max={999} value={limit} disabled={!selected || mode === "inherit" || mode === "disabled"} onChange={event => setLimit(event.target.value)} aria-invalid={Boolean(error)} /><FieldDescription>من ١ إلى ٩٩٩ غيابًا عند اختيار المتتالي أو الإجمالي.</FieldDescription></Field>
        </FieldGroup>
        {selected ? <p className="muted">القيمة الحالية: {ruleText(selected.absence_mode, selected.absence_limit)}</p> : null}
        {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
        {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      </form>
      <CenterHeaderActions>
        <Button form={formId} type="submit" variant="primary" busy={busy} disabled={!selected || conflict || !dirty}>حفظ قاعدة الغياب</Button>
        {selected && dirty ? <Button onClick={cancelRule} disabled={busy}>إلغاء التعديل</Button> : null}
        {conflict ? <Button onClick={() => window.location.reload()}>تحديث القاعدة</Button> : null}
      </CenterHeaderActions>
    </section> : null}

    {canBulkWaitlist ? <AbsenceBulkWaitlist context={context} filters={filters} selected={selectedAttemptIds} onSelectionChange={setSelectedAttemptIds} onDirtyChange={setBulkDraftDirty} onBatchIdChange={setBatchId} /> : null}
    <DataTable id="absence-review" title="طلاب الغياب" description="العداد التشغيلي يخص فترة الارتباط الحالية؛ الغياب السابق محفوظ للتاريخ." rows={context.students}
      rowKey={row => row.id} searchText={row => `${row.student_name} ${row.student_number}`} emptyMessage="لا توجد حالات ضمن هذا النطاق."
      serverSearch={{ value: filters.q ?? "", onSearch: q => navigate({
        branch_id: filters.branch_id ?? "", course_id: filters.course_id ?? "", stage_id: filters.stage_id ?? "",
        level_id: filters.level_id ?? "", group_id: filters.group_id ?? "", view: filters.view ?? "review", q,
      }) }}
      serverPagination={{ page: context.pagination.page, hasMore: context.pagination.has_more, batchSize: 50, previousHref: pageHref(Math.max(1, context.pagination.page - 1)), nextHref: pageHref(context.pagination.page + 1), onNavigate: href => router.push(href) }}
      columns={[
        { key: "selection", label: "اختيار", actions: true, render: row => {
          const allowed = row.student_status === "active" && (context.permissions.can_manage_center ||
            context.permissions.branch_actions?.[String(row.branch_id)]?.includes("enrollment.manage"));
          return allowed ? <AbsenceSelectionCell row={row} selected={selectedAttemptIds.includes(row.id)}
            disabled={selectedAttemptIds.length >= MAX_BULK_SELECTION && !selectedAttemptIds.includes(row.id)}
            onToggle={(id, checked) => setSelectedAttemptIds(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id))} /> : "—";
        } },
        { key: "student", label: "الطالب", render: row => <Link href={`/admin/students/${row.student_id}`}>{row.student_name} · {row.student_number.toLocaleString("ar-EG")}</Link> },
        { key: "scope", label: "النطاق", render: row => <>{row.branch_name} · {row.course_name} · {row.stage_name} · {row.level_name} · {row.group_name}</> },
        { key: "rule", label: "القاعدة", render: row => ruleText(row.effective_mode, row.effective_limit) },
        { key: "current", label: "الغياب الحالي", render: row => <>{row.consecutive_absences.toLocaleString("ar-EG")} متتالٍ · {row.total_absences.toLocaleString("ar-EG")} إجمالي</> },
        { key: "history", label: "غياب فترات سابقة", render: row => row.historical_absences.toLocaleString("ar-EG") },
        { key: "status", label: "الحالة", render: row => row.needs_review ? "يحتاج مراجعة" : "دون الحد" },
      ]} />
  </div>;
}
