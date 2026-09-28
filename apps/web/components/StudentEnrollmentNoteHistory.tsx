"use client";

import { useState } from "react";
import { Button } from "@/components/Button";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, responseMessage } from "@/lib/client-api";
import type { StudentEnrollmentNotePage } from "@/lib/server-context";

type Entry = { attempt_id: string; group_name: string; body: string; important: boolean; revision: number; updated_by_name: string; updated_at: string };
type Version = { revision: number; body: string; important: boolean; actor_name: string; created_at: string };
type List = StudentEnrollmentNotePage;
type Detail = { versions: Version[]; pagination: { page: number; has_more: boolean } };

export function StudentEnrollmentNoteHistory({ studentId, initial }: { studentId: string; initial: List }) {
  const [list, setList] = useState<List>(initial);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadList(page: number) {
    setBusy(true); setError("");
    try {
      const response = await centerRequest(`students/${studentId}/enrollment-notes?page=${page}`, "GET");
      if (!response.ok) throw new Error(await responseMessage(response));
      setList(await response.json() as List); setSelected(null); setDetail(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر تحميل الملاحظات."); }
    finally { setBusy(false); }
  }

  async function open(entry: Entry, page = 1) {
    setBusy(true); setError("");
    try {
      const response = await centerRequest(`students/${studentId}/enrollments/${entry.attempt_id}/note?page=${page}`, "GET");
      if (!response.ok) throw new Error(await responseMessage(response));
      const fresh = await response.json() as Detail;
      setSelected(entry);
      setDetail(previous => page === 1 ? fresh : { ...fresh, versions: [...(previous?.versions ?? []), ...fresh.versions] });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "تعذر تحميل تاريخ الملاحظة."); }
    finally { setBusy(false); }
  }

  return <section className="context-card form-stack" aria-label="ملاحظات التسجيل الدراسي">
    <h2>ملاحظات التسجيل الدراسي</h2>
    <p className="muted">الملاحظات وتاريخها ضمن فروع القراءة المصرح بها فقط.</p>
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {!list.entries.length ? <p>لا توجد ملاحظات تسجيل ضمن فروع صلاحيتك.</p> : null}
    {list.entries.map(entry => <article key={entry.attempt_id} className="context-card form-stack">
      <h3>{entry.group_name}{entry.important ? " ★" : ""}</h3>
      <p>{entry.body}</p>
      <p className="muted">{entry.updated_by_name} — <time>{entry.updated_at}</time></p>
      <Button type="button" disabled={busy} onClick={() => open(entry)}>عرض تاريخ التعديل</Button>
    </article>)}
    {list.pagination.page > 1 || list.pagination.has_more ? <nav className="pagination" aria-label="صفحات ملاحظات التسجيل">
      <Button disabled={busy || list.pagination.page === 1} onClick={() => loadList(list.pagination.page - 1)}>السابق</Button>
      <span>صفحة {list.pagination.page.toLocaleString("ar-EG")}</span>
      <Button disabled={busy || !list.pagination.has_more} onClick={() => loadList(list.pagination.page + 1)}>التالي</Button>
    </nav> : null}
    {selected && detail ? <section className="form-stack" aria-label={`تاريخ ملاحظة ${selected.group_name}`}>
      <h3>تاريخ ملاحظة {selected.group_name}</h3>
      <ol>{detail.versions.map(version => <li key={version.revision}>
        <strong>نسخة {version.revision.toLocaleString("ar-EG")}</strong> — {version.actor_name} — <time>{version.created_at}</time>
        {version.important ? " · مهمة" : ""}<p>{version.body}</p>
      </li>)}</ol>
      {detail.pagination.has_more ? <Button disabled={busy} onClick={() => open(selected, detail.pagination.page + 1)}>عرض نسخ أقدم</Button> : null}
    </section> : null}
  </section>;
}
