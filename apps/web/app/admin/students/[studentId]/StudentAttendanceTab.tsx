"use client";

import { useRouter } from "next/navigation";
import { DataTable } from "@/components/DataTable";
import { InlineNotice } from "@/components/InlineNotice";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import type { StudentAttendanceEntry, StudentContext } from "@/lib/server-context";

function entryStatus(entry: StudentAttendanceEntry) {
  if (entry.kind === "suspended") return entry.session_status === "cancelled"
    ? "إيقاف محفوظ في محاضرة ملغاة — لا يُحتسب غيابًا"
    : "لم يُحتسب غيابًا أثناء الإيقاف";
  if (entry.session_status === "cancelled") return entry.status === "absent"
    ? "غياب محفوظ في محاضرة ملغاة — لا يُحتسب"
    : "حضور محفوظ في محاضرة ملغاة — لا يُحتسب";
  if (entry.kind === "makeup") {
    if (entry.status === "counted") return "حضور تعويض محتسب";
    if (entry.status === "not_counted") return "حضور تعويض غير محتسب";
    return "غياب عن محاضرة التعويض";
  }
  if (entry.status === "counted") return "حضور محتسب";
  if (entry.status === "not_counted") return "حضور غير محتسب";
  return "غياب مسجل";
}

export function StudentAttendanceTab({ context, search, query }: { context: StudentContext; search: string; query: string }) {
  const router = useRouter();
  const student = context.students[0];
  const attendance = context.attendance!;
  const page = attendance.pagination.page;
  const href = (value: number, q = search) => {
    const params = new URLSearchParams(query);
    params.set("tab", "attendance");
    if (value > 1) params.set("attendance_page", String(value));
    else params.delete("attendance_page");
    if (q) params.set("attendance_q", q);
    else params.delete("attendance_q");
    return `/admin/students/${student.id}?${params}`;
  };
  const sessionLink = (entry: StudentAttendanceEntry) =>
    `/admin/groups/${entry.group_id}/sessions/${entry.session_id}/attendance?entry_id=${entry.id}`;

  return <section className="form-stack" aria-label="حضور الطالب وغيابه">
    <h2>الحضور والغياب والتعويض</h2>
    <p className="muted">الأحداث المسجلة في فروعك فقط. يبقى الغياب الأصلي محفوظًا بعد التعويض. فترات الإيقاف وأسبابها ظاهرة في قسم حالة الملف أعلاه، ولا تُعد غيابًا.</p>
    {student.status === "suspended" ? <InlineNotice tone="warning">ملف الطالب موقوف الآن؛ يُمنع الحضور والتعويض حتى فك الإيقاف.</InlineNotice> : null}
    {student.status === "active" && student.missing_custom_fields > 0 ? <InlineNotice tone="warning">الملف ينقصه بعض البيانات القديمة. يمكن تسجيل حضور الطالب النشط من المحاضرة وفق صلاحيتك.</InlineNotice> : null}
    <DataTable id="student-attendance-history" title="سجل المحاضرات" rows={attendance.entries} rowKey={entry => entry.id}
      description="آخر ٢٠ حدثًا في كل دفعة، مرتبة من الأحدث."
      searchText={entry => `${entry.course_name} ${entry.group_name} ${entry.branch_name} ${entry.session_number}`}
      serverSearch={{ value: search, onSearch: value => router.push(href(1, value)) }}
      emptyMessage={search.trim() ? "لا توجد أحداث تطابق البحث في الفروع المصرح بها." : "لا يوجد حضور أو غياب أو تعويض مسجل في الفروع المصرح بها."}
      pageSize={20}
      serverPagination={{ page, hasMore: attendance.pagination.has_more, batchSize: 20,
        previousHref: href(Math.max(1, page - 1)), nextHref: href(page + 1) }}
      columns={[
        { key: "date", label: "المحاضرة", render: entry => <><strong>{entry.course_name} · {entry.group_name}</strong><br />محاضرة {entry.session_number}{entry.session_title ? ` · ${entry.session_title}` : ""}<br />{new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(entry.scheduled_at))}</> },
        { key: "branch", label: "الفرع", render: entry => entry.branch_name },
        { key: "status", label: "النتيجة", render: entryStatus },
        { key: "source", label: "المصدر", actions: true, render: entry => <div className="flex flex-wrap gap-2">
          <Link href={sessionLink(entry)}>فتح سجل المحاضرة</Link>
          {entry.kind === "makeup" && entry.source_session_id && entry.source_group_id ? <Link href={`/admin/groups/${entry.source_group_id}/sessions/${entry.source_session_id}/attendance`}>فتح المحاضرة الأصلية</Link> : null}
        </div> },
      ]} />
  </section>;
}
