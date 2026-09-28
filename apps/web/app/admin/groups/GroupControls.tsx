"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions, CenterPageActions } from "@/components/CenterShell";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { DataTable } from "@/components/DataTable";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { centerRequest, newSubmissionId, responseFieldErrors, responseMessage } from "@/lib/client-api";
import type { GroupContext, GroupInstructorChoice, StudyGroup } from "@/lib/groups";

type Editor = "create" | StudyGroup | null;
type Fields = { planId: string; name: string; price: string; threshold: string; instructorIds: string[] };

export function GroupControls({ context }: { context: GroupContext }) {
  const formId = useId();
  const router = useRouter();
  const trigger = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const submitting = useRef(false);
  const optionAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [fields, setFields] = useState<Fields>({ planId: "", name: "", price: "0.00", threshold: "", instructorIds: [] });
  const [baseline, setBaseline] = useState("");
  const [requestId, setRequestId] = useState(newSubmissionId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmStart, setConfirmStart] = useState(false);
  const [optionChoices, setOptionChoices] = useState<GroupInstructorChoice[]>([]);
  const [optionQuery, setOptionQuery] = useState("");
  const [optionPage, setOptionPage] = useState(1);
  const [optionHasMore, setOptionHasMore] = useState(false);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [optionError, setOptionError] = useState("");
  const [groupDetails, setGroupDetails] = useState<StudyGroup | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [detailError, setDetailError] = useState("");
  useEffect(() => () => { optionAbort.current?.abort(); detailAbort.current?.abort(); }, []);
  useEffect(() => { if (editor && editor !== "create") heading.current?.focus(); }, [editor]);
  const dirty = editor !== null && baseline !== JSON.stringify(fields);
  const canManage = (branchId: number) => context.permissions.can_manage_center || context.permissions.branch_actions?.[String(branchId)]?.includes("curriculum.manage");
  const canCreate = context.level_choices.some(choice => canManage(choice.branch_id));
  const chosenPlan = context.level_choices.find(choice => choice.plan_version_id === fields.planId);
  const branchId = editor && editor !== "create" ? editor.branch_id : chosenPlan?.branch_id;
  const chosenGroup = editor && editor !== "create" ? editor : null;
  const instructorChoices: GroupInstructorChoice[] = [
    ...optionChoices.filter(choice => choice.branch_id === branchId),
    ...(chosenGroup?.instructors ?? []).filter(item => !optionChoices.some(choice => choice.id === item.id && choice.branch_id === branchId))
      .map(item => ({ ...item, branch_id: branchId! })),
  ];

  async function loadOptions(nextBranchId: number, page: number, query: string, replace: boolean) {
    optionAbort.current?.abort();
    const controller = new AbortController();
    optionAbort.current = controller;
    setLoadingOptions(true); setOptionError("");
    try {
      const params = new URLSearchParams({ branch_id: String(nextBranchId), page: String(page) });
      if (query.trim()) params.set("q", query.trim());
      const response = await centerRequest(`group-instructor-options?${params}`, "GET", undefined, controller.signal);
      if (!response.ok) throw new Error(await responseMessage(response));
      const result = (await response.json()) as { instructors: { id: string; name: string }[]; pagination: { has_more: boolean } };
      if (controller.signal.aborted) return;
      const next = result.instructors.map(item => ({ ...item, branch_id: nextBranchId }));
      setOptionChoices(current => {
        const retained = replace ? current.filter(item => item.branch_id === nextBranchId && fields.instructorIds.includes(item.id)) : current;
        return [...retained, ...next.filter(item => !retained.some(choice => choice.id === item.id && choice.branch_id === item.branch_id))];
      });
      setOptionPage(page); setOptionHasMore(result.pagination.has_more);
    } catch (failure) {
      if (!controller.signal.aborted) setOptionError(failure instanceof Error ? failure.message : "تعذر تحميل المحاضرين.");
    } finally { if (!controller.signal.aborted) setLoadingOptions(false); }
  }

  async function loadDetails(groupId: string) {
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    setLoadingDetails(true); setDetailError("");
    try {
      const response = await centerRequest(`groups/${groupId}`, "GET", undefined, controller.signal);
      if (!response.ok) throw new Error(await responseMessage(response));
      const details = ((await response.json()) as GroupContext).groups[0];
      if (!controller.signal.aborted) setGroupDetails(details);
    } catch (failure) {
      if (!controller.signal.aborted) setDetailError(failure instanceof Error ? failure.message : "تعذر تحميل المحاضرات المطلوبة.");
    } finally { if (!controller.signal.aborted) setLoadingDetails(false); }
  }

  function focusFieldError(errors: Record<string, string>) {
    const key = Object.keys(errors)[0] ?? "";
    const field = key.startsWith("instructor_ids") ? "instructor-search"
      : key === "plan_version_id" || key === "level_id" ? "plan"
      : key === "approved_price" ? "price"
      : key === "completion_threshold" ? "threshold" : "name";
    requestAnimationFrame(() => document.getElementById(`${formId}-${field}`)?.focus());
  }

  function open(next: Exclude<Editor, null>, preserveTrigger = false) {
    if (!preserveTrigger) trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const value: Fields = next === "create"
      ? { planId: "", name: "", price: "0.00", threshold: "", instructorIds: [] }
      : { planId: next.plan_version_id, name: next.name, price: next.approved_price,
          threshold: next.completion_threshold_override === null ? "" : String(next.completion_threshold_override),
          instructorIds: next.instructors.map(item => item.id) };
    setFields(value); setBaseline(JSON.stringify(value)); setEditor(next); setRequestId(newSubmissionId());
    setError(""); setNotice(""); setFieldErrors({}); setConflict(false);
    setOptionQuery(""); setOptionChoices([]); setOptionPage(1); setOptionHasMore(false);
    setGroupDetails(next !== "create" && next.approved_lectures ? next : null); setDetailError("");
    if (next !== "create") {
      void loadOptions(next.branch_id, 1, "", true);
      if (!next.approved_lectures) void loadDetails(next.id);
    } else detailAbort.current?.abort();
  }

  function close() {
    optionAbort.current?.abort(); detailAbort.current?.abort();
    setEditor(null); setConfirmClose(false); setConfirmStart(false); setError(""); setConflict(false);
    requestAnimationFrame(() => {
      if (trigger.current?.isConnected) trigger.current.focus();
      else if (editor && editor !== "create") document.querySelector<HTMLElement>(`[data-group-edit="${editor.id}"]`)?.focus();
      else document.querySelector<HTMLElement>("[data-group-create]")?.focus();
    });
  }

  function update(change: Partial<Fields>) {
    setFields(current => ({ ...current, ...change }));
    setFieldErrors({});
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || submitting.current || conflict) return;
    const errors: Record<string, string> = {};
    if (editor === "create" && !chosenPlan) errors.plan_version_id = "اختر مستوى وإصدار خطة من الدفعة المعروضة.";
    if (!fields.name.trim()) errors.name = "أدخل اسم المجموعة.";
    if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(fields.price)) errors.approved_price = "أدخل سعرًا غير سالب حتى منزلتين عشريتين.";
    if (fields.threshold && (!/^\d{1,3}$/.test(fields.threshold) || Number(fields.threshold) < 1 || Number(fields.threshold) > 100)) errors.completion_threshold = "أدخل نسبة بين ١ و١٠٠.";
    if (!fields.instructorIds.length) errors.instructor_ids = "اختر محاضرًا واحدًا على الأقل من الفرع.";
    if (Object.keys(errors).length) { setFieldErrors(errors); setError("راجع بيانات المجموعة."); focusFieldError(errors); return; }
    submitting.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(editor === "create" ? "groups" : `groups/${editor.id}/settings`, editor === "create" ? "POST" : "PATCH", {
        ...(editor === "create" ? { level_id: chosenPlan!.level_id, plan_version_id: chosenPlan!.plan_version_id, name: fields.name.trim(), request_id: requestId }
          : { revision: editor.revision }),
        approved_price: fields.price, completion_threshold: fields.threshold ? Number(fields.threshold) : null,
        instructor_ids: fields.instructorIds,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setError("تغيرت المجموعة أو حُفظ الطلب ببيانات مختلفة. حمّل أحدث البيانات قبل إعادة المحاولة."); }
        else { const validation = await responseFieldErrors(response); setFieldErrors(validation); setError(await responseMessage(response)); if (Object.keys(validation).length) focusFieldError(validation); }
        return;
      }
      close(); setNotice("حُفظت المجموعة وإعداداتها داخل الفرع."); router.refresh();
    } catch { setError("تعذر التأكد من الحفظ. أعد الطلب نفسه؛ لن تُنشأ مجموعة مكررة."); }
    finally { submitting.current = false; setBusy(false); }
  }

  async function recover() {
    if (!editor || submitting.current) return;
    submitting.current = true; setBusy(true);
    try {
      if (editor === "create") {
        close(); router.refresh(); setNotice("حُمّلت القائمة الحالية. راجع المجموعة قبل إنشاء طلب جديد.");
        return;
      }
      const response = await centerRequest(`groups/${editor.id}`, "GET");
      if (!response.ok) throw new Error(await responseMessage(response));
      const current = ((await response.json()) as GroupContext).groups[0];
      open(current, true);
      setNotice("حُمّلت أحدث إعدادات المجموعة. راجع القيم قبل الحفظ.");
      router.refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر تحميل أحدث المجموعة."); }
    finally { submitting.current = false; setBusy(false); }
  }

  async function start() {
    if (!chosenGroup || submitting.current) return;
    setConfirmStart(false); submitting.current = true; setBusy(true); setError("");
    try {
      const response = await centerRequest(`groups/${chosenGroup.id}/start`, "POST", { revision: chosenGroup.revision });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setError("تغيرت حالة المجموعة. حمّل أحدث بياناتها."); }
        else setError(await responseMessage(response));
        return;
      }
      close(); setNotice("بدأت المجموعة؛ بقي إصدار الخطة والسعر المعتمد محفوظين."); router.refresh();
    } catch { setError("تعذر التأكد من بدء المجموعة. حمّل أحدث حالتها قبل إعادة المحاولة."); }
    finally { submitting.current = false; setBusy(false); }
  }

  function pages(kind: keyof GroupContext["pagination"], label: string) {
    const info = context.pagination[kind];
    if (info.page === 1 && !info.has_more) return null;
    const href = (page: number) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(context.pagination)) {
        const current = key === kind ? page : value.page;
        if (current > 1) params.set(key === "groups" ? "page" : `${key}_page`, String(current));
      }
      return `/admin/groups${params.size ? `?${params}` : ""}`;
    };
    return <nav className="form-actions" aria-label={`دفعات ${label}`}>
      {info.page > 1 ? <Link href={href(info.page - 1)}>الدفعة السابقة</Link> : null}
      <span>{label} · دفعة {info.page.toLocaleString("ar-EG")} · حتى ٥٠ سجلًا</span>
      {info.has_more ? <Link href={href(info.page + 1)}>الدفعة التالية</Link> : null}
    </nav>;
  }

  return <>
    <CenterPageActions context={context} actions={canCreate ? <Button data-group-create variant="primary" disabled={busy || editor !== null} onClick={() => open("create")}>إنشاء مجموعة</Button> : undefined} />
    <UnsavedChangesGuard dirty={dirty} guardHistory />
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {editor ? <form id={formId} onSubmit={save} noValidate className="context-card form-stack" aria-label={editor === "create" ? "إنشاء مجموعة" : `إعدادات ${editor.name}`}>
      <h2 ref={heading} tabIndex={-1}>{editor === "create" ? "مجموعة جديدة" : `إعدادات ${editor.name}`}</h2>
      <FieldGroup>
        <FieldSet disabled={busy} className="form-stack" style={{ border: 0, padding: 0, margin: 0 }}>
          {editor === "create" ? <Field data-invalid={Boolean(fieldErrors.plan_version_id)}>
            <FieldLabel htmlFor={`${formId}-plan`}>المستوى وإصدار الخطة</FieldLabel>
            <NativeSelect id={`${formId}-plan`} value={fields.planId} onChange={event => {
              const selected = context.level_choices.find(choice => choice.plan_version_id === event.target.value);
              update({ planId: event.target.value, instructorIds: [] });
              setOptionChoices([]); setOptionQuery(""); setOptionPage(1); setOptionHasMore(false);
              if (selected) void loadOptions(selected.branch_id, 1, "", true);
              else optionAbort.current?.abort();
            }}>
              <NativeSelectOption value="">اختر مستوى وخطة</NativeSelectOption>
              {context.level_choices.filter(choice => canManage(choice.branch_id)).map(choice => <NativeSelectOption key={choice.plan_version_id} value={choice.plan_version_id}>{choice.branch_name} · {choice.course_name} ← {choice.stage_name} ← {choice.level_name} · الإصدار {choice.plan_version}</NativeSelectOption>)}
            </NativeSelect>
            {chosenPlan ? <FieldDescription>نسبة الإتمام الموروثة الآن: {chosenPlan.completion_threshold.toLocaleString("ar-EG")}٪. ستحتفظ المجموعة بإصدار الخطة المحدد.</FieldDescription> : null}
            {fieldErrors.plan_version_id ? <FieldError>{fieldErrors.plan_version_id}</FieldError> : null}
          </Field> : <p>{editor.branch_name} · {editor.course_name} ← {editor.stage_name} ← {editor.level_name} · إصدار الخطة {editor.plan_version.toLocaleString("ar-EG")}</p>}
          {editor === "create" ? <FormField id={`${formId}-name`} label="اسم المجموعة" value={fields.name} onChange={name => update({ name })} error={fieldErrors.name} required focusOnMount /> : null}
          {chosenGroup ? <section aria-label="المحاضرات المطلوبة للمجموعة" className="form-stack">
            <h3>محاضرات إصدار الخطة {chosenGroup.plan_version.toLocaleString("ar-EG")}</h3>
            <p>عدد المحاضرات المعتمد: {chosenGroup.approved_lecture_count.toLocaleString("ar-EG")}</p>
            {loadingDetails ? <p role="status">جارٍ تحميل المحاضرات المطلوبة…</p> : groupDetails?.approved_lectures ? <ol className="form-stack">
              {groupDetails.approved_lectures.map(lecture => <li key={lecture.number}>المحاضرة {lecture.number.toLocaleString("ar-EG")}: {lecture.content}{lecture.title ? ` · ${lecture.title}` : ""} · {lecture.planned_hours.toLocaleString("ar-EG")} ساعة مخططة</li>)}
            </ol> : null}
            {detailError ? <><InlineNotice tone="error">{detailError}</InlineNotice><Button type="button" onClick={() => void loadDetails(chosenGroup.id)}>إعادة تحميل المحاضرات</Button></> : null}
          </section> : null}
          <FormField id={`${formId}-price`} label="السعر المعتمد للمجموعة" value={fields.price} onChange={price => update({ price })} error={fieldErrors.approved_price} direction="ltr" hint="يمكن أن يكون السعر صفرًا. تثبت رسوم كل محاولة دراسة عند تسجيلها لاحقًا." />
          <Field data-invalid={Boolean(fieldErrors.completion_threshold)}>
            <FieldLabel htmlFor={`${formId}-threshold`}>نسبة الإتمام للمجموعة</FieldLabel>
            <NativeSelect id={`${formId}-threshold`} value={fields.threshold} onChange={event => update({ threshold: event.target.value })}>
              <NativeSelectOption value="">توريث نسبة الكورس أو المرحلة أو المستوى</NativeSelectOption>
              {Array.from({ length: 100 }, (_, index) => index + 1).map(value => <NativeSelectOption key={value} value={String(value)}>{value.toLocaleString("ar-EG")}٪</NativeSelectOption>)}
            </NativeSelect>
            {fieldErrors.completion_threshold ? <FieldError>{fieldErrors.completion_threshold}</FieldError> : null}
          </Field>
          <FieldSet>
            <FieldLegend>محاضرو المجموعة</FieldLegend>
            {branchId ? <div className="flex flex-wrap items-end gap-2">
              <Field className="min-w-48 flex-1">
                <FieldLabel htmlFor={`${formId}-instructor-search`}>البحث عن محاضر في الفرع</FieldLabel>
                <Input id={`${formId}-instructor-search`} value={optionQuery} maxLength={80} onChange={event => setOptionQuery(event.target.value)} />
              </Field>
              <Button type="button" disabled={loadingOptions} onClick={() => void loadOptions(branchId, 1, optionQuery, true)}>بحث</Button>
            </div> : null}
            {instructorChoices.length ? instructorChoices.map(choice => <FieldLabel key={choice.id} className="flex items-center gap-2">
              <Checkbox checked={fields.instructorIds.includes(choice.id)} onCheckedChange={checked => update({ instructorIds: checked ? [...fields.instructorIds, choice.id] : fields.instructorIds.filter(id => id !== choice.id) })} />
              {choice.name}
            </FieldLabel>) : <FieldDescription>{branchId ? "لا يوجد محاضر في النتائج الحالية لهذا الفرع." : "اختر مستوى له محاضرون مرتبطون بالفرع."}</FieldDescription>}
            {loadingOptions ? <p role="status">جارٍ تحميل المحاضرين…</p> : null}
            {optionError ? <FieldError role="alert">{optionError}</FieldError> : null}
            {branchId && optionHasMore ? <Button type="button" disabled={loadingOptions} onClick={() => void loadOptions(branchId, optionPage + 1, optionQuery, false)}>المزيد من المحاضرين</Button> : null}
            {fieldErrors.instructor_ids ? <FieldError>{fieldErrors.instructor_ids}</FieldError> : null}
          </FieldSet>
          <CenterHeaderActions>
            {conflict ? <Button disabled={busy} onClick={() => void recover()}>تحميل أحدث المجموعة</Button> : null}
            <Button form={formId} type="submit" variant="primary" busy={busy} disabled={conflict || Boolean(chosenGroup?.status === "completed")}>حفظ المجموعة</Button>
            {chosenGroup?.status === "waiting" ? <Button disabled={busy || conflict || dirty} onClick={() => setConfirmStart(true)}>بدء المجموعة</Button> : null}
            <Button disabled={busy} onClick={() => dirty ? setConfirmClose(true) : close()}>إلغاء</Button>
          </CenterHeaderActions>
        </FieldSet>
      </FieldGroup>
    </form> : <>
      <DataTable id="study-groups" title="المجموعات" description="المجموعات محدودة بدفعات. كل مجموعة تحتفظ بإصدار خطتها ومحاضريها وإعدادات دراستها." rows={context.groups} rowKey={group => group.id}
        searchText={group => `${group.name} ${group.branch_name} ${group.course_name} ${group.level_name}`}
        emptyMessage="لا توجد مجموعات متاحة. أنشئ مجموعة من مستوى له خطة ومحاضرون في الفرع."
        columns={[
          { key: "name", label: "المجموعة", filterText: row => row.name, render: row => <strong>{row.name}</strong> },
          { key: "level", label: "المسار", filterText: row => `${row.branch_name} ${row.course_name} ${row.stage_name} ${row.level_name}`, render: row => `${row.branch_name} · ${row.course_name} ← ${row.stage_name} ← ${row.level_name}` },
          { key: "plan", label: "الخطة", render: row => `إصدار ${row.plan_version.toLocaleString("ar-EG")} · ${row.approved_lecture_count.toLocaleString("ar-EG")} محاضرة معتمدة` },
          { key: "status", label: "الحالة", render: row => row.status === "waiting" ? "تنتظر البدء" : row.status === "started" ? "بدأت" : "مكتملة" },
          { key: "price", label: "السعر", render: row => row.approved_price },
          { key: "threshold", label: "الإتمام", render: row => `${row.completion_threshold.toLocaleString("ar-EG")}٪${row.completion_threshold_override === null ? " · موروثة" : " · مخصصة"}` },
          { key: "instructors", label: "المحاضرون", render: row => row.instructors.map(item => item.name).join("، ") },
          { key: "actions", label: "الإجراءات", actions: true, render: row => <div className="form-actions"><Link href={`/admin/groups/${row.id}/sessions`}>جدول المحاضرات</Link>{row.can_manage ? <Button data-group-edit={row.id} disabled={busy} onClick={() => open(row)}>إدارة {row.name}</Button> : null}</div> },
        ]} />
      {pages("groups", "المجموعات")}
      {pages("levels", "المستويات والخطط")}
    </>}
    {confirmClose ? <ConfirmationDialog title="ترك تغييرات المجموعة" description="هناك تعديلات لم تُحفظ. هل تريد إغلاق النموذج؟" confirmLabel="إغلاق دون حفظ" onCancel={() => setConfirmClose(false)} onConfirm={close} /> : null}
    {confirmStart ? <ConfirmationDialog title="بدء المجموعة" description="ستنتقل المجموعة من انتظار البدء إلى بدأت. لن يتغير إصدار خطتها أو السعر المعتمد." confirmLabel="بدء المجموعة" onCancel={() => setConfirmStart(false)} onConfirm={() => void start()} /> : null}
  </>;
}
