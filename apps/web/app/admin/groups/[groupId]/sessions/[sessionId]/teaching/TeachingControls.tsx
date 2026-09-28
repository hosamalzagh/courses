"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions, CenterPageActions } from "@/components/CenterShell";
import { InlineNotice } from "@/components/InlineNotice";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";
import type { TeachingContext, TeachingSegment } from "@/lib/groups";
import { formatSessionTime } from "@/lib/session-time";

type DraftSegment = { key: string; instructorId: string; start: string; duration: string };
type Instructor = { id: string; name: string };
type InstructorPage = { instructors: Instructor[]; pagination: { page: number; has_more: boolean } };

function draftFrom(segments: TeachingSegment[]): DraftSegment[] {
  return segments.map((row, index) => ({ key: row.id ?? `${row.instructor_id}-${row.start_minute}-${index}`, instructorId: row.instructor_id,
    start: String(row.start_minute), duration: String(row.duration_minutes) }));
}

function normalized(segments: TeachingSegment[]) {
  return [...segments].map(row => ({ instructor_id: row.instructor_id, start_minute: row.start_minute,
    duration_minutes: row.duration_minutes })).sort((a, b) => a.start_minute - b.start_minute ||
    a.instructor_id.localeCompare(b.instructor_id) || a.duration_minutes - b.duration_minutes);
}

export function TeachingControls({ context }: { context: TeachingContext }) {
  const router = useRouter();
  const prefix = useId();
  const [current, setCurrent] = useState(context);
  const [draft, setDraft] = useState(() => draftFrom(context.session.segments));
  const [reason, setReason] = useState("");
  const [options, setOptions] = useState<Instructor[]>([]);
  const [search, setSearch] = useState("");
  const [optionPage, setOptionPage] = useState(0);
  const [optionMore, setOptionMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<{ key: string; id: string } | null>(null);
  const busyRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const session = current.session;
  const path = `groups/${session.group_id}/sessions/${session.id}/teaching`;
  const instructors = new Map<string, string>();
  for (const item of [...session.suggested_instructors, ...session.segments.map(row =>
    ({ id: row.instructor_id, name: row.instructor_name ?? row.instructor_id })), ...options]) instructors.set(item.id, item.name);
  const proposed = draft.map(row => ({ instructor_id: row.instructorId, start_minute: Number(row.start),
    duration_minutes: Number(row.duration) }));
  const dirty = JSON.stringify(normalized(proposed)) !== JSON.stringify(normalized(session.segments)) || reason.trim() !== "";
  const reasonRequired = session.segments.length > 0 &&
    JSON.stringify(normalized(proposed)) !== JSON.stringify(normalized(session.segments));

  function update(key: string, change: Partial<DraftSegment>) {
    setDraft(rows => rows.map(row => row.key === key ? { ...row, ...change } : row));
    setError(""); setNotice("");
  }

  async function searchInstructors(page: number, query = search) {
    if (searchBusy) return;
    setSearchBusy(true); setError("");
    try {
      const params = new URLSearchParams({ branch_id: String(session.branch_id), page: String(page),
        ...(query.trim() ? { q: query.trim() } : {}) });
      const response = await centerRequest(`group-instructor-options?${params}`, "GET");
      if (!response.ok) throw new Error(await responseMessage(response));
      const found = await response.json() as InstructorPage;
      setOptions(previous => page === 1 ? found.instructors : [...previous, ...found.instructors]);
      setOptionPage(page); setOptionMore(found.pagination.has_more);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "تعذر البحث عن المحاضرين.");
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally { setSearchBusy(false); }
  }

  async function reload() {
    if (busyRef.current) return;
    setBusy(true); setError("");
    try {
      const response = await centerRequest(path, "GET");
      if (!response.ok) throw new Error(await responseMessage(response));
      const latest = await response.json() as TeachingContext;
      setCurrent(latest);
      setConflict(false);
      setNotice("حُمّل سجل التدريس الحالي. راجع مسودتك قبل الحفظ.");
      router.refresh();
      requestAnimationFrame(() => headingRef.current?.focus());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "تعذر تحميل السجل الحالي.");
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally { setBusy(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || !current.can_record || conflict || !dirty) return;
    setError(""); setNotice("");
    if (draft.length === 0 && session.segments.length === 0) {
      setError("أضف محاضرًا واحدًا على الأقل."); requestAnimationFrame(() => errorRef.current?.focus()); return;
    }
    for (const row of draft) {
      if (!row.instructorId || !/^\d+$/.test(row.start) || !/^\d+$/.test(row.duration) ||
        Number(row.duration) < 1 || Number(row.start) + Number(row.duration) > 720) {
        setError("اختر المحاضر وأدخل بداية ومدة صحيحتين ضمن ١٢ ساعة من موعد المحاضرة.");
        requestAnimationFrame(() => errorRef.current?.focus()); return;
      }
    }
    if (reasonRequired && reason.trim().length < 3) {
      setError("اكتب سبب التصحيح من ثلاثة أحرف على الأقل."); reasonRef.current?.focus(); return;
    }
    const segments = normalized(proposed);
    if (JSON.stringify(segments) === JSON.stringify(normalized(session.segments))) {
      setReason(""); setNotice("لا توجد تغييرات في المحاضرين أو المدد."); return;
    }
    const key = JSON.stringify([session.id, session.teaching_revision, segments, reason.trim()]);
    if (pending.current?.key !== key) pending.current = { key, id: newSubmissionId() };
    busyRef.current = true; setBusy(true);
    try {
      const response = await centerRequest(path, "PUT", { revision: session.teaching_revision,
        request_id: pending.current.id, segments, reason: reason.trim() || null });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); pending.current = null; }
        setError(await responseMessage(response));
        requestAnimationFrame(() => errorRef.current?.focus());
        return;
      }
      const saved = await response.json() as { segments: TeachingSegment[]; revision: number };
      setCurrent(previous => ({ ...previous, session: { ...previous.session,
        segments: saved.segments, teaching_revision: saved.revision } }));
      setDraft(draftFrom(saved.segments)); setReason(""); pending.current = null;
      setNotice("حُفظ سجل التدريس الفعلي وسبب التصحيح في سجل التدقيق.");
      router.refresh();
      requestAnimationFrame(() => headingRef.current?.focus());
    } catch {
      setError("تعذر التأكد من النتيجة. أعد الحفظ نفسه للتحقق دون تكرار السجل.");
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally { busyRef.current = false; setBusy(false); }
  }

  return <div className="form-stack" dir="rtl">
    <UnsavedChangesGuard dirty={dirty} guardHistory />
    <CenterPageActions context={current} actions={<>
      <Link href={`/admin/groups/${session.group_id}/sessions`}>جدول المحاضرات</Link>
      <Link href={`/admin/groups/${session.group_id}/sessions/${session.id}/attendance`}>كشف حضور الطلاب</Link>
      <Link href="/admin/audit">سجل التدقيق</Link>
    </>} />
    <section className="data-panel form-stack" aria-labelledby={`${prefix}-title`}>
      <h2 ref={headingRef} id={`${prefix}-title`} tabIndex={-1}>المحاضرة {session.number.toLocaleString("ar-EG")} · {session.group_name}</h2>
      <p>{session.title ?? "محاضرة الخطة"} · {formatSessionTime(session.scheduled_at)}</p>
      <p className="muted">سجّل وقت بداية كل محاضر بالدقائق من بداية الموعد، ثم مدة تدريسه. إذا بدأ اثنان في الدقيقة نفسها فهي مشاركة متزامنة؛ وإذا بدأ الثاني لاحقًا فهي متتابعة. حضور الطالب يبقى للمحاضرة كاملة.</p>
      {session.status === "cancelled" ? <InlineNotice>المحاضرة ملغاة، وسجل التدريس للقراءة فقط.</InlineNotice> : null}
      {!current.can_record && session.status !== "cancelled" ? <InlineNotice>يمكن تسجيل التدريس بعد بدء المجموعة وحلول موعد المحاضرة، ضمن صلاحية تسجيل الحضور للفرع.</InlineNotice> : null}
      {conflict ? <CenterHeaderActions><Button disabled={busy} onClick={() => void reload()}>تحميل أحدث سجل</Button></CenterHeaderActions> : null}
      {error ? <div ref={errorRef} tabIndex={-1}><InlineNotice tone="error">{error}</InlineNotice></div> : null}
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      {session.segments.length > 0 ? <div className="context-card form-stack">
        <h3>السجل المحفوظ</h3>
        <ul>{session.segments.map(row => <li key={row.id ?? `${row.instructor_id}-${row.start_minute}`}>
          {row.instructor_name ?? instructors.get(row.instructor_id)}: من الدقيقة {row.start_minute.toLocaleString("ar-EG")} لمدة {row.duration_minutes.toLocaleString("ar-EG")} دقيقة
        </li>)}</ul>
      </div> : <p className="muted">لم يسجل التدريس الفعلي لهذه المحاضرة بعد.</p>}
      {current.can_record ? <>
        <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); void searchInstructors(1); }}>
          <Field><FieldLabel htmlFor={`${prefix}-search`}>البحث عن محاضر بديل أو مشارك في الفرع</FieldLabel>
            <Input id={`${prefix}-search`} type="search" maxLength={80} value={search} onChange={event => setSearch(event.target.value)} /></Field>
          <Button type="submit" busy={searchBusy} disabled={searchBusy}>بحث</Button>
          {optionMore ? <Button disabled={searchBusy} onClick={() => void searchInstructors(optionPage + 1)}>المزيد من المحاضرين</Button> : null}
        </form>
        <form id={`${prefix}-form`} className="form-stack" onSubmit={event => void save(event)} noValidate>
          <h3>محاضرو اللقاء ومددهم</h3>
          {draft.map((row, index) => <div className="context-card form-stack" key={row.key}>
            <h4>الفترة {(index + 1).toLocaleString("ar-EG")}</h4>
            <FieldGroup className="grid gap-3 md:grid-cols-3">
              <Field><FieldLabel htmlFor={`${prefix}-instructor-${row.key}`}>المحاضر</FieldLabel>
                <NativeSelect id={`${prefix}-instructor-${row.key}`} value={row.instructorId} disabled={busy}
                  onChange={event => update(row.key, { instructorId: event.target.value })}>
                  <NativeSelectOption value="">اختر المحاضر</NativeSelectOption>
                  {[...instructors].map(([id, name]) => <NativeSelectOption key={id} value={id}>{name}</NativeSelectOption>)}
                </NativeSelect></Field>
              <Field><FieldLabel htmlFor={`${prefix}-start-${row.key}`}>البداية من موعد المحاضرة (دقيقة)</FieldLabel>
                <Input id={`${prefix}-start-${row.key}`} type="number" min={0} max={719} step={1} inputMode="numeric"
                  value={row.start} disabled={busy} onChange={event => update(row.key, { start: event.target.value })} /></Field>
              <Field><FieldLabel htmlFor={`${prefix}-duration-${row.key}`}>مدة التدريس (دقيقة)</FieldLabel>
                <Input id={`${prefix}-duration-${row.key}`} type="number" min={1} max={720} step={1} inputMode="numeric"
                  value={row.duration} disabled={busy} onChange={event => update(row.key, { duration: event.target.value })} /></Field>
            </FieldGroup>
            <Button disabled={busy} onClick={() => setDraft(rows => rows.filter(item => item.key !== row.key))}>حذف الفترة {(index + 1).toLocaleString("ar-EG")}</Button>
          </div>)}
          <CenterHeaderActions><Button disabled={busy || draft.length >= 50} onClick={() => setDraft(rows => [
            ...rows, { key: newSubmissionId(), instructorId: session.suggested_instructors[0]?.id ?? "", start: "0", duration: "60" },
          ])}>إضافة محاضر أو فترة</Button></CenterHeaderActions>
          <Field><FieldLabel htmlFor={`${prefix}-reason`}>سبب التصحيح {reasonRequired ? "(مطلوب)" : "(اختياري عند أول تسجيل)"}</FieldLabel>
            <Textarea ref={reasonRef} id={`${prefix}-reason`} value={reason} maxLength={1000} disabled={busy}
              onChange={event => setReason(event.target.value)} />
            <FieldDescription>أي تعديل على سجل محفوظ يظهر مع السبب والقيم السابقة واللاحقة في سجل التدقيق.</FieldDescription></Field>
          <CenterHeaderActions><Button form={`${prefix}-form`} type="submit" variant="primary" busy={busy} disabled={busy || conflict || !dirty}>حفظ التدريس الفعلي</Button>
            {dirty ? <Button disabled={busy} onClick={() => { setDraft(draftFrom(session.segments)); setReason(""); setError(""); pending.current = null; }}>إلغاء التعديلات</Button> : null}
          </CenterHeaderActions>
        </form>
      </> : null}
    </section>
  </div>;
}
