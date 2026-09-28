"use client";

import { useState } from "react";
import { Button } from "@/components/Button";
import { InlineNotice } from "@/components/InlineNotice";
import { PrefetchLink } from "@/components/PrefetchLink";
import { centerRequest, responseMessage } from "@/lib/client-api";
import type { CenterContext, StudentEnrollmentNotePage, StudentEventNote, StudentEventNotePage } from "@/lib/server-context";
import { canOpenStudentEventNote, studentEventNoteOrigin } from "@/lib/student-event-notes";

type Version = { revision: number; body: string; important: boolean; actor_name: string; created_at: string };
type History = { versions: Version[]; pagination: { has_more: boolean; next_before_revision: number | null } };
type DisplayNote = StudentEventNote & { group_name?: string };

function normalize(page: StudentEventNotePage | StudentEnrollmentNotePage, enrollmentOnly: boolean): StudentEventNotePage {
  if (!enrollmentOnly) return page as StudentEventNotePage;
  const old = page as StudentEnrollmentNotePage;
  return { pagination: old.pagination, entries: old.entries.map(entry => ({
    id: entry.attempt_id, event_type: "study_attempt", event_id: entry.attempt_id, branch_id: entry.branch_id,
    body: entry.body, important: entry.important, revision: entry.revision,
    updated_by_name: entry.updated_by_name, updated_at: entry.updated_at,
    session_id: null, group_id: null, payment_id: null, group_name: entry.group_name,
  })) };
}

function kind(note: StudentEventNote): string {
  if (note.event_type === "study_attempt") return "تسجيل دراسي";
  if (note.event_type.startsWith("attendance:")) return "حضور أو غياب";
  if (note.event_type === "payment") return "دفعة مالية";
  return "تخصيص دفعة";
}

export function StudentEventNotes({ studentId, initial, permissions, enrollmentOnly = false }: {
  studentId: string; initial: StudentEventNotePage | StudentEnrollmentNotePage;
  permissions: CenterContext["permissions"]; enrollmentOnly?: boolean;
}) {
  const [list, setList] = useState(() => normalize(initial, enrollmentOnly));
  const [selected, setSelected] = useState<DisplayNote | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function loadPage(page: number) {
    setBusy(true); setError("");
    try {
      const response = await centerRequest(`students/${studentId}/${enrollmentOnly ? "enrollment-notes" : "notes"}?page=${page}`, "GET");
      if (!response.ok) {
        if (response.status === 403 || response.status === 404) { setList({ entries: [], pagination: { page: 1, has_more: false } }); setSelected(null); setHistory(null); }
        throw new Error(await responseMessage(response));
      }
      setList(normalize(await response.json() as StudentEventNotePage | StudentEnrollmentNotePage, enrollmentOnly));
      setSelected(null); setHistory(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر تحميل الملاحظات."); }
    finally { setBusy(false); }
  }

  async function open(note: DisplayNote, beforeRevision?: number) {
    setBusy(true); setError("");
    try {
      const query = beforeRevision ? enrollmentOnly ? `?page=${beforeRevision}` : `?before_revision=${beforeRevision}` : "";
      const path = enrollmentOnly ? `enrollments/${note.event_id}/note` : `notes/${note.id}`;
      const response = await centerRequest(`students/${studentId}/${path}${query}`, "GET");
      if (!response.ok) {
        if (response.status === 403 || response.status === 404) { setSelected(null); setHistory(null); }
        throw new Error(await responseMessage(response));
      }
      const raw = await response.json() as History | { versions: Version[]; pagination: { page: number; has_more: boolean } };
      const fresh: History = enrollmentOnly
        ? { versions: raw.versions, pagination: { has_more: raw.pagination.has_more,
            next_before_revision: (raw.pagination as { page: number }).page + 1 } }
        : raw as History;
      setSelected(note);
      setHistory(previous => beforeRevision ? { ...fresh, versions: [...(previous?.versions ?? []), ...fresh.versions] } : fresh);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر تحميل تاريخ الملاحظة."); }
    finally { setBusy(false); }
  }

  return <section className="context-card form-stack" aria-label={enrollmentOnly ? "ملاحظات التسجيل الدراسي" : "ملاحظات أحداث الطالب"}>
    <h2>{enrollmentOnly ? "ملاحظات التسجيل الدراسي" : "ملاحظات الأحداث"}</h2>
    <p className="muted">تظهر ملاحظات الأحداث التي تملك صلاحية قراءتها فقط. تُحفظ جميع النسخ بعد تعديل النص أو إزالة علامة الأهمية.</p>
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {!list.entries.length ? <p>لا توجد ملاحظات مرئية في فروع صلاحيتك.</p> : null}
    {list.entries.map(note => <article key={note.id} className="context-card form-stack">
      <h3>{(note as DisplayNote).group_name ?? kind(note)}{note.important ? " ★" : ""}</h3>
      <p>{note.body}</p>
      <p className="muted">{note.updated_by_name} — <time>{note.updated_at}</time></p>
      <div className="form-actions">{canOpenStudentEventNote(note, permissions)
        ? <PrefetchLink href={studentEventNoteOrigin(studentId, note)}>فتح الحدث الأصلي</PrefetchLink> : null}
        <Button type="button" disabled={busy} onClick={() => open(note)}>{enrollmentOnly ? "عرض تاريخ التعديل" : "عرض النسخ"}</Button></div>
    </article>)}
    {list.pagination.page > 1 || list.pagination.has_more ? <nav className="pagination" aria-label="صفحات ملاحظات الأحداث">
      <Button type="button" disabled={busy || list.pagination.page === 1} onClick={() => loadPage(list.pagination.page - 1)}>السابق</Button>
      <span>صفحة {list.pagination.page.toLocaleString("ar-EG")}</span>
      <Button type="button" disabled={busy || !list.pagination.has_more} onClick={() => loadPage(list.pagination.page + 1)}>التالي</Button>
    </nav> : null}
    {selected && history ? <section className="form-stack" aria-label="نسخ الملاحظة">
      <h3>نسخ ملاحظة {kind(selected)}</h3>
      <ol>{history.versions.map(version => <li key={version.revision}>
        <strong>نسخة {version.revision.toLocaleString("ar-EG")}</strong> — {version.actor_name} — <time>{version.created_at}</time>
        {version.important ? " · مهمة" : ""}<p>{version.body}</p>
      </li>)}</ol>
      {history.pagination.has_more && history.pagination.next_before_revision ? <Button type="button" disabled={busy}
        onClick={() => open(selected, history.pagination.next_before_revision!)}>عرض نسخ أقدم</Button> : null}
    </section> : null}
  </section>;
}
