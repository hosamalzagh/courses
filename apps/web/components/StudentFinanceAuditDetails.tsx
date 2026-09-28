import type { AuditEntry } from "@/lib/server-context";
import { paymentMethodLabels } from "@/lib/student-finance";

export function StudentFinanceAuditDetails({ entry }: { entry: AuditEntry }) {
  if (!['student.payment_recorded', 'student.payment_allocated', 'student.payment_allocation_reversed', 'center.financial_currency_changed', 'student.enrolled'].includes(entry.event)) return null;
  let details = entry.details;
  if (typeof details === "string") { try { details = JSON.parse(details); } catch { return null; } }
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const data = details as Record<string, unknown>;
  if (entry.event === "center.financial_currency_changed") {
    return <p>عملة المركز: <bdi dir="ltr">{String(data.before ?? "غير محددة")} ← {String(data.after ?? "غير محددة")}</bdi></p>;
  }
  if (entry.event === "student.enrolled") {
    return <details><summary>تفاصيل محاولة الدراسة ورسومها</summary>
      <p>الطالب: <bdi dir="ltr">{String(data.student_id ?? "")}</bdi></p>
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
