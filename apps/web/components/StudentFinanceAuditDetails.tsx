import type { AuditEntry } from "@/lib/server-context";
import { paymentMethodLabels } from "@/lib/student-finance";

export function StudentFinanceAuditDetails({ entry }: { entry: AuditEntry }) {
  if (!['student.payment_recorded', 'student.payment_allocated', 'student.payment_allocation_reversed',
    'student.payment_allocation_corrected',
    'student.fee_settled', 'student.fee_settlement_corrected',
    'student.payment_note_created', 'student.payment_note_updated',
    'student.allocation_note_created', 'student.allocation_note_updated',
    'center.financial_currency_changed', 'student.enrolled', 'student.study_repeated', 'student.study_withdrawn',
    'student.study_waitlisted', 'student.study_reattached', 'student.study_transferred', 'student.study_bulk_waitlist_skipped'].includes(entry.event)) return null;
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
  if (entry.event === "student.study_bulk_waitlist_skipped") {
    return <details><summary>سبب استبعاد الطالب من النقل الجماعي</summary>
      <p>الطالب: <bdi dir="ltr">{String(data.student_id ?? "")}</bdi> — المحاولة: <bdi dir="ltr">{String(data.attempt_id ?? "")}</bdi></p>
      <p>دفعة النقل: <bdi dir="ltr">{String(data.batch_id ?? "")}</bdi></p>
      <p>السبب: {String(data.reason ?? "")}</p>
    </details>;
  }
  if (entry.event === "student.study_withdrawn") {
    return <details><summary>تفاصيل انسحاب الطالب</summary>
      <p>الطالب: <bdi dir="ltr">{String(data.student_id ?? "")}</bdi> — المحاولة: <bdi dir="ltr">{String(data.attempt_id ?? "")}</bdi></p>
      <p>المجموعة: <bdi dir="ltr">{String(data.group_id ?? "")}</bdi> — تاريخ الانسحاب: <bdi dir="ltr">{String(data.withdrawn_on ?? "")}</bdi></p>
      <p>السبب: {String(data.reason ?? "")}</p>
    </details>;
  }
  if (entry.event === "student.study_transferred") {
    const before = data.before && typeof data.before === "object" && !Array.isArray(data.before)
      ? data.before as Record<string, unknown> : null;
    const after = data.after && typeof data.after === "object" && !Array.isArray(data.after)
      ? data.after as Record<string, unknown> : null;
    return <details><summary>تفاصيل نقل محاولة الدراسة</summary>
      <p>الطالب: <bdi dir="ltr">{String(data.student_id ?? "")}</bdi> — المحاولة: <bdi dir="ltr">{String(data.attempt_id ?? "")}</bdi></p>
      {before ? <p>السياق السابق: فرع <bdi dir="ltr">{String(before.branch_id ?? "")}</bdi>، مستوى <bdi dir="ltr">{String(before.level_id ?? "")}</bdi>، خطة <bdi dir="ltr">{String(before.plan_version_id ?? "")}</bdi>، مجموعة <bdi dir="ltr">{String(before.group_id ?? "انتظار")}</bdi></p> : null}
      {after ? <p>الوجهة: فرع <bdi dir="ltr">{String(after.branch_id ?? "")}</bdi>، مستوى <bdi dir="ltr">{String(after.level_id ?? "")}</bdi>، خطة <bdi dir="ltr">{String(after.plan_version_id ?? "")}</bdi>، مجموعة <bdi dir="ltr">{String(after.group_id ?? "")}</bdi></p> : null}
      <p>تاريخ النقل: <bdi dir="ltr">{String(data.transferred_on ?? "")}</bdi> — السبب: {String(data.reason ?? "")}</p>
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
      {data.batch_id ? <p>دفعة النقل: <bdi dir="ltr">{String(data.batch_id)}</bdi></p> : null}
    </details>;
  }
  if (entry.event === "student.fee_settled" || entry.event === "student.fee_settlement_corrected") {
    return <details><summary>تفاصيل قرار الرسوم</summary>
      <p>الطالب: <bdi dir="ltr">{String(data.student_id ?? "")}</bdi> — الرسوم: <bdi dir="ltr">{String(data.fee_id ?? "")}</bdi></p>
      <p>المستحق قبل: <bdi dir="ltr">{String(data.before_due ?? "")}</bdi> — بعد: <bdi dir="ltr">{String(data.after_due ?? "")} {String(data.currency ?? "")}</bdi></p>
      {data.replaces_adjustment_id ? <p>تصحيح قرار: <bdi dir="ltr">{String(data.replaces_adjustment_id)}</bdi></p> : null}
      <p>السبب: {String(data.reason ?? "")}</p>
      {Array.isArray(data.released_allocations) && data.released_allocations.length ? <p>أعيد جزء من التخصيصات إلى الرصيد المتاح بعد التسوية.</p> : null}
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
      <p>فرع الاستلام: {String(data.source_branch_name ?? data.branch_id ?? "")}</p>
      <p>المتاح قبل: <bdi dir="ltr">{String(data.payment_available_before ?? "")}</bdi> — بعد: <bdi dir="ltr">{String(data.payment_available_after ?? "")} {String(data.currency ?? "")}</bdi></p>
      {allocations.map((allocation) => <p key={String(allocation.id)}>فرع الرسوم: {String(allocation.target_branch_name ?? allocation.target_branch_id ?? data.branch_id ?? "")} — رسوم <bdi dir="ltr">{String(allocation.fee_id ?? "")}</bdi>: <bdi dir="ltr">{String(allocation.amount ?? "")} {String(data.currency ?? "")}</bdi> — المستحق قبل: <bdi dir="ltr">{String(allocation.fee_due_before ?? "")}</bdi>، بعد: <bdi dir="ltr">{String(allocation.fee_due_after ?? "")}</bdi></p>)}
    </details>;
  }
  if (entry.event === "student.payment_allocation_reversed") {
    return <details><summary>تفاصيل عكس التخصيص</summary>
      <p>التخصيص: <bdi dir="ltr">{String(data.allocation_id ?? "")}</bdi> — المبلغ: <bdi dir="ltr">{String(data.amount ?? "")}</bdi></p>
      <p>فرع الاستلام: <bdi dir="ltr">{String(entry.branch_id ?? "")}</bdi> — فرع الرسوم: <bdi dir="ltr">{String(Array.isArray(data.related_branch_ids) ? data.related_branch_ids[0] : entry.branch_id ?? "")}</bdi></p>
      <p>السبب: {String(data.reason ?? "")}</p>
      <p>المتاح قبل: <bdi dir="ltr">{String(data.payment_available_before ?? "")}</bdi> — بعد: <bdi dir="ltr">{String(data.payment_available_after ?? "")}</bdi></p>
      <p>المسدد قبل: <bdi dir="ltr">{String(data.fee_paid_before ?? "")}</bdi> — بعد: <bdi dir="ltr">{String(data.fee_paid_after ?? "")}</bdi></p>
    </details>;
  }
  if (entry.event === "student.payment_allocation_corrected") {
    const previous = data.old_target as Record<string, unknown> | null;
    const next = data.new_target as Record<string, unknown> | null;
    const before = data.account_before as Record<string, unknown> | null;
    const after = data.account_after as Record<string, unknown> | null;
    return <details><summary>تفاصيل تصحيح التخصيص</summary>
      <p>الدفعة: <bdi dir="ltr">{String(data.payment_id ?? "")}</bdi> — التخصيص الأصلي: <bdi dir="ltr">{String(data.original_allocation_id ?? "")}</bdi></p>
      <p>من {String(previous?.branch_name ?? "")} إلى {String(next?.branch_name ?? "الرصيد المتاح")}: <bdi dir="ltr">{String(data.amount ?? "")} {String(data.currency ?? "")}</bdi></p>
      {next ? <p>التخصيص الصحيح: <bdi dir="ltr">{String(data.replacement_allocation_id ?? "")}</bdi> — رسوم: <bdi dir="ltr">{String(next.fee_id ?? "")}</bdi></p> : null}
      <p>رصيد الفروع المعنية: <bdi dir="ltr">{String(before?.available_balance ?? "")}</bdi> ← <bdi dir="ltr">{String(after?.available_balance ?? "")}</bdi>؛ المديونية: <bdi dir="ltr">{String(before?.debt ?? "")}</bdi> ← <bdi dir="ltr">{String(after?.debt ?? "")}</bdi></p>
      <p>السبب: {String(data.reason ?? "")}</p>
    </details>;
  }
  return <details><summary>تفاصيل الدفعة المقدمة</summary>
    <p>الطالب: <bdi dir="ltr">{String(data.student_id ?? "")}</bdi></p>
    <p>المبلغ: <bdi dir="ltr">{String(data.amount ?? "")} {String(data.currency ?? "")}</bdi></p>
    <p>الاستلام: {paymentMethodLabels[String(data.method)] ?? "غير محدد"} — <bdi dir="ltr">{String(data.received_on ?? "")}</bdi></p>
  </details>;
}
