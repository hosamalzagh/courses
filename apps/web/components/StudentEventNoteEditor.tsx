"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { InlineNotice } from "@/components/InlineNotice";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";
import type { StudyAttemptNote } from "@/lib/server-context";

type NoteVersion = { revision: number; body: string; important: boolean; actor_name: string; created_at: string };
type Detail = { entry_revision?: number; note: (StudyAttemptNote & { created_by_name: string; created_at: string; updated_at: string }) | null;
  versions: NoteVersion[]; pagination: { page: number; has_more: boolean } };
export function StudentEventNoteEditor({ path, title, description, onClose, onSaved, onDirtyChange, canEdit = true }: {
  path: string; title: string; description: string; onClose: () => void; canEdit?: boolean;
  onSaved: (note: StudyAttemptNote) => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const router = useRouter();
  const prefix = useId();
  const formId = `${prefix}-event-note`;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [body, setBody] = useState("");
  const [important, setImportant] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [staleOccurrence, setStaleOccurrence] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  const dirty = detail !== null && (body !== (detail.note?.body ?? "") || important !== (detail.note?.important ?? false));

  useEffect(() => { requestAnimationFrame(() => document.getElementById(`${prefix}-heading`)?.focus()); }, [prefix]);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    let active = true;
    centerRequest(path, "GET").then(async response => {
      if (!active) return;
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const fresh = await response.json() as Detail;
      if (!active) return;
      setDetail(fresh); setBody(fresh.note?.body ?? ""); setImportant(fresh.note?.important ?? false);
    }).catch(() => { if (active) setError("تعذر تحميل الملاحظة ونسخها."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; onDirtyChange(false); };
  }, [path, onDirtyChange]);

  async function reload() {
    setBusy(true); setError("");
    try {
      const response = await centerRequest(path, "GET");
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const fresh = await response.json() as Detail;
      const preserveDraft = conflict && dirty && !staleOccurrence;
      setDetail(fresh);
      if (!preserveDraft) { setBody(fresh.note?.body ?? ""); setImportant(fresh.note?.important ?? false); }
      setConflict(false); setStaleOccurrence(false); setUncertain(false); requestId.current = null;
      setNotice(staleOccurrence ? "حُمّلت واقعة الحضور الحالية وتُركت المسودة القديمة. اكتب ملاحظة جديدة إذا كانت مناسبة لها."
        : preserveDraft ? "حُمّلت أحدث نسخة وبقيت مسودتك. قارنها بتاريخ التعديل قبل إعادة الحفظ." : "حُمّلت أحدث نسخة. راجعها قبل التعديل.");
    } catch { setError("تعذر تحميل أحدث نسخة. تحقق من الاتصال وأعد المحاولة."); }
    finally { setBusy(false); }
  }

  async function loadMore() {
    if (!detail || !detail.pagination.has_more) return;
    setBusy(true);
    try {
      const response = await centerRequest(`${path}?page=${detail.pagination.page + 1}`, "GET");
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const next = await response.json() as Detail;
      setDetail(previous => previous ? { ...previous, versions: [...previous.versions, ...next.versions], pagination: next.pagination } : next);
    } catch { setError("تعذر تحميل النسخ الأقدم."); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !detail || conflict || (!dirty && !uncertain)) return;
    const trimmed = body.trim();
    if (!trimmed || trimmed.length > 2000) {
      setError("اكتب ملاحظة من ١ إلى ٢٠٠٠ حرف.");
      document.getElementById(`${prefix}-body`)?.focus(); return;
    }
    submitting.current = true; setBusy(true); setError(""); setNotice("");
    try {
      requestId.current ??= newSubmissionId();
      const response = await centerRequest(path, "PUT", {
        body: trimmed, important, revision: detail.note?.revision ?? 0, request_id: requestId.current,
        ...(detail.entry_revision !== undefined ? { entry_revision: detail.entry_revision } : {}),
      });
      if (!response.ok) {
        if (response.status === 409) {
          const result = await response.clone().json().catch(() => ({}));
          const occurrenceChanged = result.code === "attendance_occurrence_changed";
          setConflict(true); setStaleOccurrence(occurrenceChanged); setUncertain(false);
          setError(occurrenceChanged ? "تغيرت واقعة الحضور منذ فتح الملاحظة. حمّل الواقعة الحالية قبل كتابة ملاحظة لها."
            : "تغيرت الملاحظة منذ فتحها. حمّل أحدث نسخة قبل الحفظ.");
        } else setError(await responseMessage(response));
        return;
      }
      const result = await response.json() as { note: StudyAttemptNote };
      onSaved(result.note);
      requestId.current = null; setUncertain(false); setConflict(false); setStaleOccurrence(false);
      setNotice("حُفظت الملاحظة ونسخة تعديلها دون تغيير الواقعة.");
      setDetail(previous => previous ? { ...previous, note: result.note as Detail["note"] } : previous);
      setBody(result.note.body); setImportant(result.note.important);
      router.refresh();
      try {
        const fresh = await centerRequest(path, "GET");
        if (!fresh.ok) throw new Error("refresh failed");
        const next = await fresh.json() as Detail;
        setDetail(next); setBody(next.note?.body ?? ""); setImportant(next.note?.important ?? false);
      } catch {
        setNotice("حُفظت الملاحظة، لكن تعذر تحديث تاريخ النسخ. افتحها مرة أخرى لمراجعة التاريخ.");
      }
    } catch {
      setUncertain(true); setError("تعذر تأكيد الحفظ. أعد المحاولة بالطلب نفسه دون تغيير النص.");
    } finally { submitting.current = false; setBusy(false); }
  }

  return <section className="form-stack" aria-label={title}>
    <h3 id={`${prefix}-heading`} tabIndex={-1}>{title}</h3>
    <p className="muted">{description}</p>
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {loading ? <><p role="status">جارٍ تحميل الملاحظة…</p><CenterHeaderActions>
      <Button onClick={onClose}>إلغاء</Button>
    </CenterHeaderActions></> : !detail ? <CenterHeaderActions>
      <Button disabled={busy} onClick={reload}>إعادة المحاولة</Button>
      <Button disabled={busy} onClick={onClose}>إلغاء</Button>
    </CenterHeaderActions> : <>
      {canEdit ? <form id={formId} onSubmit={save} noValidate className="form-stack">
        <Field data-invalid={Boolean(error && !conflict)}>
          <FieldLabel htmlFor={`${prefix}-body`}>نص الملاحظة</FieldLabel>
          <Textarea id={`${prefix}-body`} value={body} maxLength={2000} disabled={busy || uncertain}
            aria-invalid={Boolean(error && !conflict)} onChange={event => { setBody(event.target.value); requestId.current = null; setError(""); }} />
          <FieldDescription>حتى ٢٠٠٠ حرف. نسخ التعديل محفوظة في تاريخ الحدث.</FieldDescription>
          {error && !conflict ? <FieldError>{error}</FieldError> : null}
        </Field>
        <FieldLabel className="flex items-center gap-2"><Checkbox checked={important} disabled={busy || uncertain}
          onCheckedChange={value => { setImportant(value === true); requestId.current = null; }} />ملاحظة مهمة</FieldLabel>
      </form> : detail.note ? <p>{detail.note.body}{detail.note.important ? " · مهمة" : ""}</p> : <p>لا توجد ملاحظة لهذا الحضور.</p>}
      <CenterHeaderActions>
        {canEdit ? <Button form={formId} type="submit" variant="primary" busy={busy} disabled={conflict || (!dirty && !uncertain)}>{uncertain ? "التحقق من الحفظ" : detail.note ? "حفظ تعديل الملاحظة" : "إضافة الملاحظة"}</Button> : null}
        {conflict ? <Button disabled={busy} onClick={reload}>{staleOccurrence ? "تحميل الواقعة الحالية" : "تحميل أحدث نسخة"}</Button> : null}
        <Button disabled={busy || uncertain} onClick={onClose}>إلغاء</Button>
      </CenterHeaderActions>
      {detail.note ? <section aria-label="نسخ تعديل الملاحظة"><h4>تاريخ التعديل</h4>
        <ol>{detail.versions.map(version => <li key={version.revision}>
          <strong>نسخة {version.revision.toLocaleString("ar-EG")}</strong> — {version.actor_name} — <time>{version.created_at}</time>
          {version.important ? <span> · مهمة</span> : null}<p>{version.body}</p>
        </li>)}</ol>
        {detail.pagination.has_more ? <Button disabled={busy} onClick={loadMore}>عرض نسخ أقدم</Button> : null}
      </section> : null}
    </>}
  </section>;
}
