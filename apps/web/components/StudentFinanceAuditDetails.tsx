import type { AuditEntry } from "@/lib/server-context";
import { paymentMethodLabels } from "@/lib/student-finance";

export function StudentFinanceAuditDetails({ entry }: { entry: AuditEntry }) {
  if (!['student.payment_recorded', 'center.financial_currency_changed', 'student.enrolled'].includes(entry.event)) return null;
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
  return <details><summary>تفاصيل الدفعة المقدمة</summary>
    <p>الطالب: <bdi dir="ltr">{String(data.student_id ?? "")}</bdi></p>
    <p>المبلغ: <bdi dir="ltr">{String(data.amount ?? "")} {String(data.currency ?? "")}</bdi></p>
    <p>الاستلام: {paymentMethodLabels[String(data.method)] ?? "غير محدد"} — <bdi dir="ltr">{String(data.received_on ?? "")}</bdi></p>
  </details>;
}
