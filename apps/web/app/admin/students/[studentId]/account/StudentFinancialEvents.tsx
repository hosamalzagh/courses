"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/Button";
import { CenterHeaderActions } from "@/components/CenterShell";
import { DataTable } from "@/components/DataTable";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import type { StudentAccountContext, StudentFinancialEvent } from "@/lib/server-context";
import { FinancialEventNoteEditor } from "./FinancialEventNoteEditor";

const labels: Record<StudentFinancialEvent["event_type"], string> = {
  allocation_correction: "تصحيح تخصيص دفعة",
  fee_adjustment: "تسوية رسوم أو تصحيحها",
  refund: "استرداد فعلي",
  refund_correction: "تصحيح استرداد",
  payment_correction: "تصحيح دفعة وتخصيصاتها",
};

export function StudentFinancialEvents({ studentId, account, focusedEventId, pageHref, onDirtyChange }: {
  studentId: string; account: StudentAccountContext; focusedEventId?: string;
  pageHref: (page: number) => string; onDirtyChange: (dirty: boolean) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(focusedEventId ?? null);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [noteDirty, setNoteDirty] = useState(false);
  const handleNoteDirtyChange = useCallback((dirty: boolean) => {
    setNoteDirty(dirty);
    onDirtyChange(dirty);
  }, [onDirtyChange]);
  const selected = account.events.find(event => event.event_id === selectedId);
  const note = account.events.find(event => event.event_id === noteId);
  const currency = account.account.currency ?? "";

  return <section className="context-card form-stack" aria-label="الحركات المالية اللاحقة">
    <h2>التصحيحات والتسويات والاستردادات</h2>
    <p className="muted">كل صف مرتبط بحركة مالية معتمدة فعلية. يبقى السبب الإلزامي محفوظًا، والملاحظة اختيارية ومستقلة عن الرصيد.</p>
    <DataTable id="student-financial-events" title="سجل الحركات المالية اللاحقة" rows={account.events}
      rowKey={event => `${event.event_type}:${event.event_id}`} pageSize={20}
      searchText={event => `${labels[event.event_type]} ${event.reason} ${event.actor_name} ${event.amount_after}`}
      emptyMessage="لا توجد تصحيحات أو تسويات أو استردادات مرئية في فروع صلاحيتك."
      columns={[
        { key: "type", label: "الحركة", render: event => labels[event.event_type] },
        { key: "branch", label: "الفرع", render: event => `فرع ${event.branch_id}` },
        { key: "amount", label: "قبل ← بعد", render: event => <bdi dir="ltr">{event.amount_before} ← {event.amount_after} {currency}</bdi> },
        { key: "reason", label: "السبب", render: event => event.reason },
        { key: "actor", label: "الموظف", render: event => event.actor_name },
        { key: "date", label: "التاريخ", render: event => <bdi dir="ltr">{event.created_at}</bdi> },
        { key: "actions", label: "الإجراءات", actions: true, render: event => <Button disabled={noteDirty}
          onClick={() => { setSelectedId(event.event_id); setNoteId(null); requestAnimationFrame(() => document.getElementById("financial-event-detail")?.focus()); }}>تفاصيل الحركة</Button> },
      ]} />
    {selected ? <section className="context-card form-stack" aria-labelledby="financial-event-detail">
      <h3 id="financial-event-detail" tabIndex={-1}>{labels[selected.event_type]}</h3>
      <p>هوية الحركة: <bdi dir="ltr">{selected.event_id}</bdi></p>
      <p>الفرع: {selected.branch_id}{selected.related_branch_id !== selected.branch_id ? `، الفرع المرتبط: ${selected.related_branch_id}` : ""}
        {selected.second_related_branch_id && selected.second_related_branch_id !== selected.related_branch_id ? `، فرع البديل: ${selected.second_related_branch_id}` : ""}</p>
      <p>المبلغ: <bdi dir="ltr">{selected.amount_before}</bdi> ← <bdi dir="ltr">{selected.amount_after} {currency}</bdi>.</p>
      <p>السبب المعتمد: {selected.reason}</p>
      {selected.original_id ? <p>الحركة الأصلية: <bdi dir="ltr">{selected.original_id}</bdi></p> : null}
      {selected.replacement_id ? <p>الحركة البديلة: <bdi dir="ltr">{selected.replacement_id}</bdi></p> : null}
      {selected.payment_id ? <p>الدفعة: <bdi dir="ltr">{selected.payment_id}</bdi></p> : null}
      {selected.fee_id ? <p>الرسوم: <bdi dir="ltr">{selected.fee_id}</bdi></p> : null}
      <CenterHeaderActions>
        <Button disabled={noteDirty} onClick={() => setNoteId(selected.event_id)}>ملاحظة هذه الحركة وتاريخها</Button>
        {selected.payment_id ? <Link href={`/admin/students/${studentId}/account?payment_id=${selected.payment_id}`}>فتح الدفعة المرتبطة</Link> : null}
        <Button disabled={noteDirty} onClick={() => { setSelectedId(null); setNoteId(null); }}>إغلاق التفاصيل</Button>
      </CenterHeaderActions>
    </section> : null}
    {note ? <FinancialEventNoteEditor key={`${note.event_type}:${note.event_id}`} studentId={studentId}
      type={note.event_type} eventId={note.event_id} label={labels[note.event_type]}
      onClose={() => setNoteId(null)} onDirtyChange={handleNoteDirtyChange} /> : null}
    <CenterHeaderActions>
      {account.pagination.events_page > 1 ? <Link href={pageHref(account.pagination.events_page - 1)}>حركات أحدث</Link> : null}
      {account.pagination.events_has_more ? <Link href={pageHref(account.pagination.events_page + 1)}>حركات أقدم</Link> : null}
    </CenterHeaderActions>
  </section>;
}
