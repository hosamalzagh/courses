"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/Button";
import { CenterHeaderActions, CenterPageActions } from "@/components/CenterShell";
import { DataTable } from "@/components/DataTable";
import { InlineNotice } from "@/components/InlineNotice";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { StudentEventNoteEditor } from "@/components/StudentEventNoteEditor";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";
import type { AttendanceContext, AttendanceRow } from "@/lib/groups";
import { formatSessionTime } from "@/lib/session-time";

type Action = { kind: "record" | "undo" | "close"; key: string; requestId: string };
type Selection = { attemptId: string; mode: "record" | "undo" };
type NoteSelection = { entryId: string; entryRevision: number };

export function AttendanceControls({ context, search }: { context: AttendanceContext; search: string }) {
  const router = useRouter();
  const titleId = useId();
  const busyRef = useRef(false);
  const pending = useRef<Action | null>(null);
  const [loadedContext, setLoadedContext] = useState(context);
  const [current, setCurrent] = useState(context);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [selectedNote, setSelectedNote] = useState<NoteSelection | null>(null);
  const [noteDirty, setNoteDirty] = useState(false);
  const [discardNote, setDiscardNote] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  if (loadedContext !== context) {
    const sameRevision = context.session.id === current.session.id && context.session.revision === current.session.revision;
    setLoadedContext(context);
    if (context.session.id !== current.session.id || context.session.revision >= current.session.revision) {
      setCurrent(context);
      setConflict(false);
      if (!sameRevision || (selected && !context.students.some(row => row.attempt_id === selected.attemptId))) setSelected(null);
      if (selectedNote && !context.students.some(row => row.entry_id === selectedNote.entryId)) {
        setSelectedNote(null); setNoteDirty(false); setDiscardNote(false);
      }
    }
  }

  const { group, session } = current;
  const path = `groups/${group.id}/sessions/${session.id}`;
  const attendanceUrl = (page: number, q = search) => {
    const params = new URLSearchParams({ ...(page > 1 ? { page: String(page) } : {}), ...(q ? { q } : {}) });
    return `/admin/${path}/attendance${params.size ? `?${params}` : ""}`;
  };
  const open = !session.closed_at && session.status !== "cancelled";
  const started = current.has_started;
  const canRecord = open && started && current.can_record;
  const canClose = open && started && current.can_close;
  const selectedRow = current.students.find(row => row.attempt_id === selected?.attemptId);
  const noteRow = current.students.find(row => row.entry_id === selectedNote?.entryId && row.status !== null);
  const canEditNote = current.can_record || current.can_correct;

  async function reload() {
    const params = new URLSearchParams({ page: String(current.pagination.page), ...(search ? { q: search } : {}) });
    const response = await centerRequest(`${path}/attendance?${params}`, "GET");
    if (!response.ok) throw new Error(await responseMessage(response));
    setCurrent((await response.json()) as AttendanceContext);
    setConflict(false);
    setSelected(null);
    router.refresh();
  }

  async function action(kind: Action["kind"], key: string, endpoint: string, body: object) {
    if (busyRef.current || conflict) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    if (!pending.current || pending.current.kind !== kind || pending.current.key !== key) {
      pending.current = { kind, key, requestId: newSubmissionId() };
    }
    try {
      const response = await centerRequest(endpoint, "POST", { ...body, revision: session.revision,
        request_id: pending.current.requestId });
      if (!response.ok) {
        if (response.status === 409) setConflict(true);
        setError(await responseMessage(response));
        if (response.status !== 503) pending.current = null;
        return;
      }
      await reload();
      pending.current = null;
      if (kind === "close") {
        setConfirmClose(false);
        setNotice("أُغلق كشف المحاضرة واعتمد غياب الطلاب المستحقين غير المسجلين.");
      } else {
        setNotice(kind === "undo" ? "تم التراجع عن آخر حضور سجلته في المحاضرة المفتوحة." : "حُفظ حضور الطالب كاملًا.");
      }
      requestAnimationFrame(() => document.getElementById(`${titleId}-title`)?.focus());
    } catch {
      setError("تعذر التأكد من النتيجة. أعد الإجراء نفسه للتحقق دون تكراره.");
    } finally {
      busyRef.current = false; setBusy(false);
    }
  }

  function record(row: AttendanceRow, status: "counted" | "not_counted") {
    void action("record", `${row.attempt_id}-${status}`, `${path}/attendance`, { attempt_id: row.attempt_id, status });
  }

  function select(row: AttendanceRow, mode: Selection["mode"]) {
    setSelectedNote(null);
    setConfirmClose(false);
    setSelected({ attemptId: row.attempt_id, mode });
    requestAnimationFrame(() => document.getElementById(`${titleId}-selection`)?.focus());
  }

  function cancelSelection() {
    const target = selected ? `${titleId}-${selected.attemptId}-${selected.mode}` : "";
    setSelected(null);
    requestAnimationFrame(() => document.getElementById(target)?.focus());
  }

  function closeNote() {
    if (noteDirty) { setDiscardNote(true); return; }
    discardSelectedNote();
  }

  function discardSelectedNote() {
    const target = selectedNote ? `${titleId}-${selectedNote.entryId}-note` : "";
    setSelectedNote(null); setNoteDirty(false); setDiscardNote(false);
    requestAnimationFrame(() => document.getElementById(target)?.focus());
  }

  return <>
    <UnsavedChangesGuard dirty={noteDirty} guardHistory onDiscard={() => {
      setSelectedNote(null); setNoteDirty(false); setDiscardNote(false);
    }} />
    <CenterPageActions context={current} actions={<Link href={`/admin/groups/${group.id}/sessions`}>العودة لجدول المحاضرات</Link>} />
    {canClose && !confirmClose && !selected && !selectedNote ? <CenterHeaderActions><Button id={`${titleId}-close`} variant="primary" disabled={busy || conflict}
      onClick={() => { setConfirmClose(true); requestAnimationFrame(() => document.getElementById(`${titleId}-confirm`)?.focus()); }}>إغلاق كشف المحاضرة</Button></CenterHeaderActions> : null}
    {selected && selectedRow && !conflict ? <CenterHeaderActions>
      {selected.mode === "record" ? <>
        <Button variant="primary" busy={busy} onClick={() => record(selectedRow, "counted")}>حاضر محتسب</Button>
        <Button busy={busy} onClick={() => record(selectedRow, "not_counted")}>حاضر غير محتسب</Button>
      </> : <Button variant="primary" busy={busy} onClick={() => void action("undo", selectedRow.attempt_id,
        `${path}/attendance/${selectedRow.entry_id}/undo`, {})}>تأكيد التراجع</Button>}
      <Button disabled={busy} onClick={cancelSelection}>إلغاء</Button>
    </CenterHeaderActions> : null}
    {confirmClose && canClose ? <CenterHeaderActions><Button variant="primary" busy={busy} disabled={conflict}
      onClick={() => void action("close", session.id, `${path}/close`, {})}>تأكيد الإغلاق</Button>
      <Button disabled={busy} onClick={() => { setConfirmClose(false); requestAnimationFrame(() => document.getElementById(`${titleId}-close`)?.focus()); }}>إلغاء</Button></CenterHeaderActions> : null}
    {conflict ? <CenterHeaderActions><Button disabled={busy} onClick={() => void reload().then(() => setNotice("حُمّل أحدث كشف؛ راجع الحالة قبل إعادة الإجراء.")).catch(failure => setError(failure instanceof Error ? failure.message : "تعذر التحديث."))}>تحميل أحدث البيانات</Button></CenterHeaderActions> : null}
    {discardNote ? <CenterHeaderActions><Button variant="danger" onClick={discardSelectedNote}>تجاهل التعديلات</Button>
      <Button onClick={() => setDiscardNote(false)}>متابعة التعديل</Button></CenterHeaderActions> : null}
    {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    <section className="context-card form-stack" aria-labelledby={`${titleId}-title`}>
      <h2 id={`${titleId}-title`} tabIndex={-1}>{group.name} · المحاضرة {session.number.toLocaleString("ar-EG")}{session.title ? ` · ${session.title}` : ""}</h2>
      <p>الموعد: {formatSessionTime(session.scheduled_at)}. {session.status === "cancelled" ? "المحاضرة ملغاة ولا يُعتمد عنها غياب." : session.closed_at ? "كشف الحضور مغلق." : "غير المسجل لا يُحسب غائبًا قبل الإغلاق."}</p>
      {!started && open ? <p>يمكن تسجيل الحضور بعد بدء المجموعة وحلول موعد المحاضرة، بشرط أن تكون المجموعة قد بدأت قبل موعدها.</p> : null}
      {confirmClose ? <div id={`${titleId}-confirm`} tabIndex={-1} role="status">سيصبح الطلاب المستحقون غير المسجلين غائبين. راجع الكشف قبل التأكيد.</div> : null}
      {selectedRow ? <div id={`${titleId}-selection`} tabIndex={-1} role="status">
        {selected?.mode === "record" ? `اختر نوع الحضور للطالب ${selectedRow.name} من إجراءات أعلى الصفحة.`
          : `راجع آخر إدخال للطالب ${selectedRow.name}، ثم أكد التراجع من إجراءات أعلى الصفحة.`}
      </div> : null}
    </section>
    {noteRow && selectedNote ? <StudentEventNoteEditor key={`${selectedNote.entryId}-${selectedNote.entryRevision}`}
      path={`${path}/attendance/${selectedNote.entryId}/note`} expectedEntryRevision={selectedNote.entryRevision}
      title={`ملاحظة ${noteRow.status === "absent" ? "غياب" : "حضور"} ${noteRow.name}`}
      description="الملاحظة اختيارية وترتبط بواقعة الحضور أو الغياب. لا تغير الحالة أو الاحتساب أو إغلاق المحاضرة، ولا تحل محل سبب تصحيح إلزامي."
      canEdit={canEditNote} hideActions={discardNote} onClose={closeNote} onDirtyChange={setNoteDirty}
      onOccurrenceChanged={async () => {
        await reload();
        discardSelectedNote();
        setNotice("تغيرت واقعة الحضور. حُمّل الكشف الحالي؛ افتح ملاحظتها الجديدة بعد مراجعة الحالة.");
      }}
      onSaved={note => setCurrent(previous => ({ ...previous, students: previous.students.map(row => row.entry_id === noteRow.entry_id
        ? { ...row, note_body: note.body, note_important: note.important } : row) }))} /> : null}
    <DataTable id={`attendance-${session.id}`} title="كشف الطلاب المستحقين" description="يعرض الطلاب المرتبطين بالمجموعة وقت المحاضرة، مع فترات الإيقاف المستبعدة من الحضور والغياب." rows={current.students}
      rowKey={row => row.attempt_id} searchText={row => `${row.name} ${row.student_number}`} emptyMessage="لا يوجد طلاب مستحقون لهذه المحاضرة."
      serverSearch={{ value: search, onSearch: value => {
        if (noteDirty) { setNotice("احفظ الملاحظة أو ألغِ تعديلها قبل البحث."); return; }
        router.push(attendanceUrl(1, value));
      } }}
      columns={[
        { key: "student", label: "الطالب", render: row => <Link href={`/admin/students/${row.student_id}`}>{row.name}</Link> },
        { key: "number", label: "رقم الطالب", render: row => row.student_number.toLocaleString("ar-EG") },
        { key: "status", label: "الحضور", render: row => row.suspended_at
          ? <span>مستبعد بسبب الإيقاف<br /><small>من {formatSessionTime(row.suspended_at)}{row.lifted_at ? ` إلى ${formatSessionTime(row.lifted_at)}` : " إلى الآن"}</small></span>
          : row.status === "counted" ? "حاضر محتسب" : row.status === "not_counted" ? "حاضر غير محتسب" : row.status === "absent" ? "غائب"
          : row.student_status === "suspended" ? "ملف الطالب موقوف حاليًا" : "غير مسجل" },
        { key: "note", label: "ملاحظة", render: row => row.status && row.note_body
          ? <span>{row.note_important ? "★ " : ""}{row.note_body.slice(0, 80)}{row.note_body.length > 80 ? "…" : ""}</span> : "—" },
        { key: "actions", label: "الإجراءات", actions: true, render: row => <div className="flex flex-wrap gap-2">
          {canRecord && !row.status && !row.suspended_at && row.student_status === "active"
            ? <Button id={`${titleId}-${row.attempt_id}-record`} disabled={busy || conflict || Boolean(selectedNote)} onClick={() => select(row, "record")}>تسجيل الحضور</Button> : null}
          {open && current.can_undo_own && row.entry_id && row.recorded_by === current.user.id && current.last_own_attempt_id === row.attempt_id && row.status !== "absent"
            ? <Button id={`${titleId}-${row.attempt_id}-undo`} disabled={busy || conflict || Boolean(selectedNote)}
                onClick={() => select(row, "undo")}>عرض التراجع</Button> : null}
          {row.status && row.entry_id && row.entry_revision !== null && (row.note_body || canEditNote) ? <Button id={`${titleId}-${row.entry_id}-note`} size="sm" disabled={busy || conflict || Boolean(selectedNote)}
            onClick={() => { setSelected(null); setConfirmClose(false);
              setSelectedNote({ entryId: row.entry_id!, entryRevision: row.entry_revision! }); setDiscardNote(false); }}>
              {row.note_body ? "عرض الملاحظة" : "إضافة ملاحظة"}</Button> : null}
        </div> },
      ]}
      serverPagination={{ page: current.pagination.page, hasMore: current.pagination.has_more, batchSize: 20,
        previousHref: attendanceUrl(current.pagination.page - 1),
        nextHref: attendanceUrl(current.pagination.page + 1) }} />
  </>;
}
