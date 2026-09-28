import type { AuditEntry } from "@/lib/server-context";
import { paymentMethodLabels } from "@/lib/student-finance";

export function StudentFinanceAuditDetails({ entry }: { entry: AuditEntry }) {
  if (!['student.payment_recorded', 'student.payment_allocated', 'student.payment_allocation_reversed',
    'student.payment_note_created', 'student.payment_note_updated',
    'student.allocation_note_created', 'student.allocation_note_updated',
    'center.financial_currency_changed', 'student.enrolled', 'student.study_repeated', 'student.study_withdrawn',
    'student.study_waitlisted', 'student.study_reattached'].includes(entry.event)) return null;
  let details = entry.details;
  if (typeof details === "string") { try { details = JSON.parse(details); } catch { return null; } }
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const data = details as Record<string, unknown>;
  if (entry.event.startsWith('student.payment_note_') || entry.event.startsWith('student.allocation_note_')) {
    return <details><summary>تفاصيل ملاحظة الحركة المالية</summary>
      <p>الطالب: <bdi dir="ltr">{String(data.student_id ?? "")}</bdi></p>
      <p>{entry.event.startsWith('student.payment_note_') ? 'الدفعة' : 'التخصيص'}: <bdi dir="ltr">{String(data.event_id ?? "")}</bdi></p>
      <p>نسخة <bdi dir="ltr">{String(data.revision ?? "")}</bdi> — {data.important ? 'مهمة' : 'عادية'}. نص الملاحظة متاح من الحركة المالية ضمن صلاحياتها.</p>
    </details>;
  }
  if (entry.event === "center.financial_currency_changed") {
    return <p>عملة المركز: <bdi dir="ltr">{String(data.before ?? "غير محددة")} ← {String(data.after ?? "غير محددة")}</bdi></p>;
  }
  if (entry.event === "student.study_withdrawn") {
    return <details><summary>تفاصيل انسحاب الطالب</summary>
      <p>الطالب: <bdi dir="ltr">{String(data.student_id ?? "")}</bdi> — المحاولة: <bdi dir="ltr">{String(data.attempt_id ?? "")}</bdi></p>
      <p>المجموعة: <bdi dir="ltr">{String(data.group_id ?? "")}</bdi> — تاريخ الانسحاب: <bdi dir="ltr">{String(data.withdrawn_on ?? "")}</bdi></p>
      <p>السبب: {String(data.reason ?? "")}</p>
    </details>;
  }
  if (entry.event === "student.study_waitlisted" || entry.event === "student.study_reattached") {
    return <details><summary>تفاصيل انتقال محاولة الدراسة</summary>
      <p>الطالب: <bdi dir="ltr">{String(data.student_id ?? "")}</bdi> — المحاولة: <bdi dir="ltr">{String(data.attempt_id ?? "")}</bdi></p>
      <p>المجموعة السابقة: <bdi dir="ltr">{String(data.from_group_id ?? "")}</bdi>
        {data.to_group_id ? <> — المجموعة الجديدة: <bdi dir="ltr">{String(data.to_group_id)}</bdi></> : null}</p>
      <p>تاريخ الانتظار: <bdi dir="ltr">{String(data.entered_on ?? data.waitlisted_on ?? "")}</bdi>
        {data.joined_on ? <> — تاريخ الإلحاق: <bdi dir="ltr">{String(data.joined_on)}</bdi></> : null}</p>
      <p>السبب: {String(data.reason ?? "")}</p>
    </details>;
  }
  if (entry.event === "student.enrolled" || entry.event === "student.study_repeated") {
    return <details><summary>تفاصيل محاولة الدراسة ورسومها</summary>
      <p>الطالب: <bdi dir="ltr">{String(data.student_id ?? "")}</bdi></p>
      {data.repeated_from_attempt_id ? <p>إعادة دراسة للمحاولة: <bdi dir="ltr">{String(data.repeated_from_attempt_id)}</bdi></p> : null}
      <p>المجموعة: <bdi dir="ltr">{String(data.group_id ?? "")}</bdi> — تاريخ الانضمام: <bdi dir="ltr">{String(data.joined_on ?? "")}</bdi></p>
      <p>السعر: <bdi dir="ltr">{String(data.original_price ?? "")} {String(data.currency ?? "")}</bdi> — الخصم: <bdi dir="ltr">{String(data.discount ?? "")}</bdi> — الصافي: <bdi dir="ltr">{String(data.net_amount ?? "")}</bdi></p>
      {data.discount_reason ? <p>سبب الخصم: {String(data.discount_reason)}</p> : null}
    </details>;
  }
  if (entry.event === "student.payment_allocated") {
    const allocations = Array.isArray(data.allocations) ? data.allocations as Record<string, unknown>[] : [];
    return <details><summary>تفاصيل تخصيص الدفعة</summary>
      <p>الدفعة: <bdi dir="ltr">{String(data.payment_id ?? "")}</bdi></p>
      <p>المتاح قبل: <bdi dir="ltr">{String(data.payment_available_before ?? "")}</bdi> — بعد: <bdi dir="ltr">{String(data.payment_available_after ?? "")} {String(data.currency ?? "")}</bdi></p>
      {allocations.map((allocation) => <p key={String(allocation.id)}>رسوم <bdi dir="ltr">{String(allocation.fee_id ?? "")}</bdi>: <bdi dir="ltr">{String(allocation.amount ?? "")} {String(data.currency ?? "")}</bdi> — المستحق قبل: <bdi dir="ltr">{String(allocation.fee_due_before ?? "")}</bdi>، بعد: <bdi dir="ltr">{String(allocation.fee_due_after ?? "")}</bdi></p>)}
    </details>;
  }
  if (entry.event === "student.payment_allocation_reversed") {
    return <details><summary>تفاصيل عكس التخصيص</summary>
      <p>التخصيص: <bdi dir="ltr">{String(data.allocation_id ?? "")}</bdi> — المبلغ: <bdi dir="ltr">{String(data.amount ?? "")}</bdi></p>
      <p>السبب: {String(data.reason ?? "")}</p>
      <p>المتاح قبل: <bdi dir="ltr">{String(data.payment_available_before ?? "")}</bdi> — بعد: <bdi dir="ltr">{String(data.payment_available_after ?? "")}</bdi></p>
      <p>المسدد قبل: <bdi dir="ltr">{String(data.fee_paid_before ?? "")}</bdi> — بعد: <bdi dir="ltr">{String(data.fee_paid_after ?? "")}</bdi></p>
    </details>;
  }
  return <details><summary>تفاصيل الدفعة المقدمة</summary>
    <p>الطالب: <bdi dir="ltr">{String(data.student_id ?? "")}</bdi></p>
    <p>المبلغ: <bdi dir="ltr">{String(data.amount ?? "")} {String(data.currency ?? "")}</bdi></p>
    <p>الاستلام: {paymentMethodLabels[String(data.method)] ?? "غير محدد"} — <bdi dir="ltr">{String(data.received_on ?? "")}</bdi></p>
  </details>;
}
