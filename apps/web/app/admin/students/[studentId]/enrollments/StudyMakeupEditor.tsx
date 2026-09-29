"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { DataTable } from "@/components/DataTable";
import { InlineNotice } from "@/components/InlineNotice";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";
import { formatSessionTime } from "@/lib/session-time";
import type { StudyEnrollmentContext } from "@/lib/server-context";

type Attempt = StudyEnrollmentContext["attempts"][number];
type Session = { id: string; group_id: string; group_name: string; branch_id: number; number: number;
  title: string | null; scheduled_at: string; status: "planned" | "held" | "cancelled";
  revision: number; plan_lecture_id: string | null; can_book: boolean; can_prove: boolean;
  booking_id: string | null; source_session_id: string | null; booked_at: string | null;
  booked_source: Absence | null; proved_at: string | null; attendance_status: string | null };
type Absence = { id: string; group_name: string; number: number; scheduled_at: string; branch_id: number };
type Workspace = { attempt: { id: string; revision: number; status: string }; sessions: Session[];
  pagination: { page: number; has_more: boolean } };

export function StudyMakeupEditor({ studentId, attempt, onClose, onDirtyChange }: {
  studentId: string; attempt: Attempt; onClose: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const router = useRouter();
  const prefix = useId();
  const formId = `${prefix}-makeup`;
  const pendingId = useRef<string | null>(null);
  const submitting = useRef(false);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [page, setPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [sourceAbsences, setSourceAbsences] = useState<Absence[]>([]);
  const [absencePage, setAbsencePage] = useState(1);
  const [hasMoreAbsences, setHasMoreAbsences] = useState(false);
  const [absencesFailed, setAbsencesFailed] = useState(false);
  const [absenceRetry, setAbsenceRetry] = useState(0);
  const [absencesLoading, setAbsencesLoading] = useState(false);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const selected = workspace?.sessions.find(session => session.id === selectedId);
  const availableAbsences = selected?.booked_source && !sourceAbsences.some(absence => absence.id === selected.booked_source?.id)
    ? [selected.booked_source, ...sourceAbsences] : sourceAbsences;
  const dirty = Boolean(selectedId || sourceId || reason);
  const endpoint = `students/${studentId}/enrollments/${attempt.id}/makeup`;
  const workspacePath = `${endpoint}?page=${page}${searchTerm ? `&q=${encodeURIComponent(searchTerm)}` : ""}`;

  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    let cancelled = false;
    centerRequest(workspacePath, "GET").then(async response => {
      if (!response.ok) throw new Error(await responseMessage(response));
      return response.json() as Promise<Workspace>;
    }).then(data => { if (!cancelled) { setWorkspace(data); setLoading(false); setConflict(false); } })
      .catch(cause => { if (!cancelled) { setError(cause instanceof Error ? cause.message : "تعذر تحميل التعويضات."); setLoading(false); } });
    return () => { cancelled = true; };
  }, [workspacePath]);
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    centerRequest(`${endpoint}/absences?page=${absencePage}`, "GET").then(async response => {
      if (!response.ok) throw new Error(await responseMessage(response));
      return response.json() as Promise<{ source_absences: Absence[]; pagination: { has_more: boolean } }>;
    }).then(data => { if (!cancelled) {
      setSourceAbsences(previous => absencePage === 1 ? data.source_absences : [...previous, ...data.source_absences]);
      setHasMoreAbsences(data.pagination.has_more);
      setAbsencesFailed(false);
    } })
      .catch(cause => { if (!cancelled) { setAbsencesFailed(true);
        setError(cause instanceof Error ? cause.message : "تعذر تحميل الغيابات الأصلية."); } })
      .finally(() => { if (!cancelled) setAbsencesLoading(false); });
    return () => { cancelled = true; };
  }, [endpoint, selectedId, absencePage, absenceRetry]);

  function close() {
    if (dirty || uncertain) { setDiscard(true); return; }
    onClose();
  }

  async function reload() {
    setLoading(true); setError("");
    try {
      const response = await centerRequest(workspacePath, "GET");
      if (!response.ok) throw new Error(await responseMessage(response));
      setWorkspace(await response.json() as Workspace);
      setConflict(false); setUncertain(false);
      setSelectedId(""); setSourceId(""); setReason(""); pendingId.current = null;
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر تحديث بيانات التعويض."); }
    finally { setLoading(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !workspace || submitting.current || conflict) return;
    const proof = selected.status === "held";
    if (proof && reason.trim().length < 3) { setError("اكتب سبب إثبات التعويض من ثلاثة أحرف على الأقل."); return; }
    submitting.current = true; setBusy(true); setError(""); setNotice("");
    pendingId.current ??= newSubmissionId();
    try {
      const response = await centerRequest(`${endpoint}/${proof ? "prove" : "book"}`, "POST", {
        session_id: selected.id, source_session_id: sourceId || null,
        attempt_revision: workspace.attempt.revision, session_revision: selected.revision,
        ...(proof ? { reason: reason.trim() } : {}), request_id: pendingId.current,
      });
      if (!response.ok) {
        setError(await responseMessage(response));
        if (response.status === 409) setConflict(true);
        if (response.status !== 503) { pendingId.current = null; setUncertain(false); }
        return;
      }
      setNotice(proof ? "ثُبت حضور التعويض في المحاضرة المغلقة مع السبب وسجل التدقيق."
        : "حُجز التعويض. لا تُحسب التغطية حتى تسجيل الحضور المحتسب.");
      await reload();
      requestAnimationFrame(() => document.getElementById(`${prefix}-title`)?.focus());
    } catch {
      setUncertain(true);
      setError("تعذر التأكد من النتيجة. أعد الإجراء بالمفتاح نفسه للتحقق دون تكرار الحجز أو الحضور.");
    } finally { submitting.current = false; setBusy(false); }
  }

  return <section className="context-card form-stack" aria-label="حضور التعويض">
    <h2 id={`${prefix}-title`} tabIndex={-1}>حضور التعويض — {attempt.level_name}</h2>
    <p>اختر محاضرة من مجموعة أخرى. الحجز لا يمنح تغطية؛ يُحسب المحتوى مرة واحدة فقط بعد الحضور. يبقى الغياب الأصلي والمجموعة الأساسية محفوظين.</p>
    {loading ? <p role="status">جارٍ تحميل محاضرات التعويض…</p> : null}
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {conflict || uncertain ? <CenterHeaderActions><Button disabled={busy} onClick={() => void reload()}>تحميل أحدث البيانات</Button></CenterHeaderActions> : null}
    {workspace && !loading ? <>
      <DataTable id={`${prefix}-sessions`} title="محاضرات التعويض" rows={workspace.sessions} rowKey={row => row.id}
        pageSize={20} searchText={row => `${row.group_name} ${row.number} ${row.title ?? ""}`}
        serverSearch={{ value: searchTerm, onSearch: value => {
          if (busy || dirty || uncertain) { setError("ألغِ اختيار المحاضرة أو تحقق من نتيجة الطلب قبل البحث."); return; }
          if (value === searchTerm && page === 1) return;
          setError(""); setLoading(true); setPage(1); setSearchTerm(value);
        } }}
        emptyMessage="لا توجد محاضرات في هذه الدفعة." description="تظهر حتى ٢٠ محاضرة في كل دفعة. يمكن اختيار محاضرة مفتوحة للحجز أو مغلقة لإثبات حضور سابق."
        columns={[
          { key: "group", label: "المجموعة", render: row => row.group_name },
          { key: "lecture", label: "المحاضرة", render: row => `${row.number}${row.title ? ` — ${row.title}` : ""}` },
          { key: "time", label: "الموعد", render: row => formatSessionTime(row.scheduled_at) },
          { key: "state", label: "الحالة", render: row => row.status === "cancelled"
            ? row.attendance_status === "counted" ? "ملغاة — الحضور محفوظ تاريخيًا ولا يُحتسب" : "الحجز ملغى مع المحاضرة"
            : row.attendance_status === "counted" ? "حضور محتسب"
              : row.booking_id ? "محجوزة" : row.status === "held" ? "مغلقة" : "مفتوحة" },
          { key: "actions", label: "الإجراءات", actions: true, render: row => row.status === "cancelled"
            ? <span className="muted">ملغاة</span> : row.booking_id && row.attendance_status
            ? <span className="muted">مسجل</span> : (row.status === "planned" && row.can_book && !row.booking_id)
              || (row.status === "held" && row.can_prove)
              ? <Button id={`${prefix}-select-${row.id}`} type="button" disabled={busy || conflict || uncertain}
                onClick={() => { if (selectedId === row.id) return;
                  setSelectedId(row.id); setSourceId(row.source_session_id ?? ""); setReason("");
                  setSourceAbsences([]); setAbsencePage(1); setHasMoreAbsences(false);
                  setAbsencesFailed(false);
                  setAbsencesLoading(true); pendingId.current = null;
                  requestAnimationFrame(() => document.getElementById(`${prefix}-source`)?.focus()); }}>
                {row.status === "held" ? "إثبات تعويض" : "حجز تعويض"}</Button> : <span className="muted">غير متاح</span> },
        ]} />
      {workspace.pagination.page > 1 || workspace.pagination.has_more ? <div className="form-actions">
        <Button disabled={workspace.pagination.page <= 1 || busy || dirty} onClick={() => { setLoading(true); setPage(page - 1); }}>المحاضرات السابقة</Button>
        <Button disabled={!workspace.pagination.has_more || busy || dirty} onClick={() => { setLoading(true); setPage(page + 1); }}>المحاضرات التالية</Button>
      </div> : null}
      {selected ? <form id={formId} aria-label={selected.status === "held" ? "إثبات حضور تعويض" : "حجز حضور تعويض"} onSubmit={save} className="form-stack">
        <h3>{selected.group_name} — المحاضرة {selected.number.toLocaleString("ar-EG")}</h3>
        <FieldGroup>
          <Field><FieldLabel htmlFor={`${prefix}-source`}>الغياب الأصلي المرتبط، إن وجد</FieldLabel>
            <NativeSelect id={`${prefix}-source`} value={sourceId} onChange={event => { setSourceId(event.target.value); pendingId.current = null; }} disabled={busy || uncertain || absencesLoading}>
              <NativeSelectOption value="">محتوى ناقص دون ربط بغياب محدد</NativeSelectOption>
              {availableAbsences.map(absence => <NativeSelectOption key={absence.id} value={absence.id}>
                {absence.group_name} — المحاضرة {absence.number} — {formatSessionTime(absence.scheduled_at)}
                {absence.id === selected.booked_source?.id ? " (مصدر الحجز)" : ""}
              </NativeSelectOption>)}
            </NativeSelect>{absencesLoading ? <FieldDescription>جارٍ تحميل الغيابات الأصلية…</FieldDescription> : null}</Field>
          {hasMoreAbsences || absencesFailed ? <Button type="button" disabled={busy || uncertain || absencesLoading}
            onClick={() => { setAbsencesLoading(true);
              if (absencesFailed) setAbsenceRetry(previous => previous + 1);
              else setAbsencePage(previous => previous + 1); }}>
            {absencesFailed ? "إعادة تحميل الغيابات" : "تحميل غيابات أقدم"}
          </Button> : null}
          {selected.status === "held" ? <Field><FieldLabel htmlFor={`${prefix}-reason`}>سبب إثبات الحضور بعد الإغلاق</FieldLabel>
            <Textarea id={`${prefix}-reason`} value={reason} maxLength={1000} required disabled={busy || uncertain}
              onChange={event => { setReason(event.target.value); pendingId.current = null; }} />
            <FieldDescription>يتطلب صلاحية تصحيح الحضور، ويظهر السبب والقيمة الجديدة في سجل التدقيق.</FieldDescription></Field> : null}
        </FieldGroup>
      </form> : null}
    </> : null}
    {selected ? <CenterHeaderActions>
      <Button form={formId} type="submit" variant="primary" busy={busy} disabled={conflict || (selected.status === "held" && reason.trim().length < 3)}>
        {selected.status === "held" ? "حفظ إثبات التعويض" : "تأكيد حجز التعويض"}</Button>
      <Button disabled={busy || uncertain} onClick={() => { const id = `${prefix}-select-${selected.id}`; setSelectedId(""); setSourceId(""); setReason(""); pendingId.current = null;
        requestAnimationFrame(() => document.getElementById(id)?.focus()); }}>إلغاء الاختيار</Button>
    </CenterHeaderActions> : null}
    <CenterHeaderActions><Button disabled={busy} onClick={close}>إغلاق التعويض</Button></CenterHeaderActions>
    {discard ? <ConfirmationDialog title="تجاهل بيانات التعويض" description={uncertain
      ? "قد يكون الطلب قد حُفظ ولم يصلنا الرد. إغلاق المحرر يلغي إعادة المحاولة بالمفتاح نفسه؛ راجع السجل قبل طلب جديد."
      : "هل تريد إغلاق محرر التعويض ومسح الاختيار والسبب؟"}
      confirmLabel="تجاهل البيانات" onCancel={() => setDiscard(false)} onConfirm={() => { setDiscard(false); onClose(); }} /> : null}
  </section>;
}
