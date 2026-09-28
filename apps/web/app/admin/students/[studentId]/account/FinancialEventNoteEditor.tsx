"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { InlineNotice } from "@/components/InlineNotice";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";

type Note = { id: string; body: string; important: boolean; revision: number; created_by_name: string; updated_by_name: string; created_at: string; updated_at: string };
type Version = { revision: number; body: string; important: boolean; actor_name: string; created_at: string };
type Detail = { note: Note | null; can_edit: boolean; versions: Version[]; pagination: { page: number; has_more: boolean } };

export function FinancialEventNoteEditor({ studentId, type, eventId, label, onClose, onDirtyChange }: {
  studentId: string; type: "payment" | "allocation"; eventId: string; label: string;
  onClose: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const prefix = useId();
  const formId = `${prefix}-note-form`;
  const path = `students/${studentId}/${type === "payment" ? "payments" : "allocations"}/${eventId}/note`;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [body, setBody] = useState("");
  const [important, setImportant] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  const dirty = detail !== null && (body !== (detail.note?.body ?? "") || important !== (detail.note?.important ?? false));

  const load = useCallback(async (preserveDraft = false) => {
    setBusy(true); setError("");
    try {
      const response = await centerRequest(path, "GET");
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const fresh = await response.json() as Detail;
      setDetail(fresh);
      if (!preserveDraft) { setBody(fresh.note?.body ?? ""); setImportant(fresh.note?.important ?? false); }
      setConflict(false); setUncertain(false); requestId.current = null;
    } catch { setError("تعذر تحميل ملاحظة الحركة. تحقق من الاتصال وأعد المحاولة."); }
    finally { setBusy(false); setLoading(false); }
  }, [path]);

  useEffect(() => { const timeout = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timeout); }, [load]);
  useEffect(() => { onDirtyChange(dirty || uncertain); return () => onDirtyChange(false); }, [dirty, uncertain, onDirtyChange]);

  async function loadMore() {
    if (!detail?.pagination.has_more) return;
    setBusy(true); setError("");
    try {
      const response = await centerRequest(`${path}?page=${detail.pagination.page + 1}`, "GET");
      if (!response.ok) { setError(await responseMessage(response)); return; }
      const next = await response.json() as Detail;
      setDetail(previous => previous ? { ...next, versions: [...previous.versions, ...next.versions] } : next);
    } catch { setError("تعذر تحميل نسخ التعديل الأقدم."); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !detail || !detail.can_edit || conflict || (!dirty && !uncertain)) return;
    const trimmed = body.trim();
    if (!trimmed || trimmed.length > 2000) {
      setError("اكتب ملاحظة من ١ إلى ٢٠٠٠ حرف."); document.getElementById(`${prefix}-body`)?.focus(); return;
    }
    submitting.current = true; setBusy(true); setError(""); setNotice("");
    try {
      requestId.current ??= newSubmissionId();
      const response = await centerRequest(path, "PUT", {
        body: trimmed, important, revision: detail.note?.revision ?? 0, request_id: requestId.current,
      });
      if (!response.ok) {
        if (response.status === 409) { setConflict(true); setUncertain(false); setError("تغيرت الملاحظة. حمّل أحدث نسخة وقارنها قبل الحفظ."); }
        else setError(await responseMessage(response));
        return;
      }
      const saved = await response.json() as { note: Note };
      setDetail(previous => previous ? { ...previous, note: saved.note } : previous);
      setBody(saved.note.body); setImportant(saved.note.important);
      setNotice("حُفظت الملاحظة وتاريخ تعديلها دون تغيير المبلغ أو الرصيد.");
      requestId.current = null; setUncertain(false); setConflict(false);
      await load();
    } catch { setUncertain(true); setError("تعذر تأكيد الحفظ. أعد المحاولة بالطلب نفسه دون تغيير النص."); }
    finally { submitting.current = false; setBusy(false); }
  }

  return <section className="context-card form-stack" aria-label={`ملاحظة ${label}`}>
    <h3>ملاحظة {label}</h3>
    <p className="muted">الملاحظة اختيارية ولا تغيّر الحركة المالية أو تحل محل سبب التصحيح الإلزامي.</p>
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    {loading ? <p role="status">جارٍ تحميل الملاحظة…</p> : detail ? <>
      <p>{detail.note ? `آخر تعديل: ${detail.note.updated_by_name} — ${detail.note.updated_at}` : "لا توجد ملاحظة لهذه الحركة."}</p>
      {detail.can_edit ? <><form id={formId} onSubmit={save} noValidate className="form-stack">
        <Field data-invalid={Boolean(error && !conflict)}>
          <FieldLabel htmlFor={`${prefix}-body`}>نص الملاحظة</FieldLabel>
          <Textarea id={`${prefix}-body`} value={body} maxLength={2000} disabled={busy || uncertain}
            aria-invalid={Boolean(error && !conflict)} onChange={event => { setBody(event.target.value); requestId.current = null; setError(""); }} />
          <FieldDescription>حتى ٢٠٠٠ حرف، وتُحفظ كل نسخة مع الكاتب والوقت.</FieldDescription>
          {error && !conflict ? <FieldError>{error}</FieldError> : null}
        </Field>
        <FieldLabel className="flex items-center gap-2"><Checkbox checked={important} disabled={busy || uncertain}
          onCheckedChange={value => { setImportant(value === true); requestId.current = null; }} />ملاحظة مهمة</FieldLabel>
      </form>
      <CenterHeaderActions><Button form={formId} type="submit" variant="primary" busy={busy}
        disabled={conflict || (!dirty && !uncertain)}>{uncertain ? "التحقق من الحفظ" : detail.note ? "حفظ تعديل الملاحظة" : "إضافة الملاحظة"}</Button>
        {conflict ? <Button disabled={busy} onClick={() => void load(dirty)}>تحميل أحدث نسخة</Button> : null}
        <Button disabled={busy || (!dirty && !uncertain)} onClick={() => {
          setBody(detail.note?.body ?? ""); setImportant(detail.note?.important ?? false);
          setConflict(false); setUncertain(false); setError(""); requestId.current = null;
          document.getElementById(`${prefix}-body`)?.focus();
        }}>إلغاء التعديل</Button>
      </CenterHeaderActions></> : <p>لديك صلاحية عرض الملاحظة وتاريخها فقط.</p>}
      {detail.note ? <section aria-label="تاريخ تعديل ملاحظة الحركة"><h4>تاريخ التعديل</h4><ol>
        {detail.versions.map(version => <li key={version.revision}><strong>نسخة {version.revision.toLocaleString("ar-EG")}</strong> — {version.actor_name} — <time>{version.created_at}</time>{version.important ? " · مهمة" : ""}<p>{version.body}</p></li>)}
      </ol>{detail.pagination.has_more ? <Button disabled={busy} onClick={loadMore}>عرض نسخ أقدم</Button> : null}</section> : null}
    </> : null}
    <CenterHeaderActions><Button disabled={busy || uncertain || dirty} onClick={onClose}>إغلاق الملاحظة</Button></CenterHeaderActions>
  </section>;
}
