import type { AuditEntry } from "@/lib/server-context";
import { paymentMethodLabels } from "@/lib/student-finance";

export function StudentFinanceAuditDetails({ entry }: { entry: AuditEntry }) {
  if (!['student.payment_recorded', 'center.financial_currency_changed'].includes(entry.event)) return null;
  let details = entry.details;
  if (typeof details === "string") { try { details = JSON.parse(details); } catch { return null; } }
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const data = details as Record<string, unknown>;
  if (entry.event === "center.financial_currency_changed") {
    return <p>عملة المركز: <bdi dir="ltr">{String(data.before ?? "غير محددة")} ← {String(data.after ?? "غير محددة")}</bdi></p>;
  }
  return <details><summary>تفاصيل الدفعة المقدمة</summary>
    <p>الطالب: <bdi dir="ltr">{String(data.student_id ?? "")}</bdi></p>
    <p>المبلغ: <bdi dir="ltr">{String(data.amount ?? "")} {String(data.currency ?? "")}</bdi></p>
    <p>الاستلام: {paymentMethodLabels[String(data.method)] ?? "غير محدد"} — <bdi dir="ltr">{String(data.received_on ?? "")}</bdi></p>
  </details>;
}
