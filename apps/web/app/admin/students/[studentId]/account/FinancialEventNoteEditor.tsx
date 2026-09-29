"use client";

import { StudentEventNoteEditor } from "@/components/StudentEventNoteEditor";

export function FinancialEventNoteEditor({ studentId, type, eventId, label, onClose, onDirtyChange }: {
  studentId: string; type: "payment" | "allocation" | "allocation_correction" | "fee_adjustment" | "refund" | "refund_correction" | "payment_correction"; eventId: string; label: string;
  onClose: () => void; onDirtyChange: (dirty: boolean) => void;
}) {
  return <div className="context-card"><StudentEventNoteEditor
    path={`students/${studentId}/${type === "payment" ? "payments" : type === "allocation" ? "allocations" : `financial-events/${type}`}/${eventId}/note`}
    title={`ملاحظة ${label}`}
    description="الملاحظة اختيارية ولا تغيّر الحركة المالية أو تحل محل سبب التصحيح الإلزامي."
    closeLabel="إغلاق الملاحظة" resetAction
    emptyMessage="لا توجد ملاحظة لهذه الحركة."
    savedMessage="حُفظت الملاحظة وتاريخ تعديلها دون تغيير المبلغ أو الرصيد."
    historyLabel="تاريخ تعديل ملاحظة الحركة"
    onClose={onClose} onSaved={() => {}} onDirtyChange={onDirtyChange}
  /></div>;
}
