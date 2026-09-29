"use client";

import { useRouter } from "next/navigation";
import { DataTable } from "@/components/DataTable";
import { InlineNotice } from "@/components/InlineNotice";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import type { StudentContext, StudentStudyAttempt } from "@/lib/server-context";

function attemptStatus(attempt: StudentStudyAttempt) {
  if (attempt.status === "completed") return attempt.exceptional ? "اكتملت الدراسة استثنائيًا" : "اكتملت الدراسة بقرار محفوظ";
  if (attempt.status === "withdrawn") return "انسحب من المحاولة";
  if (attempt.latest_waitlist && !attempt.latest_waitlist.left_on) return "ينتظر مجموعة للمستوى";
  if (attempt.status === "transferred") return "انتقل من هذه المجموعة";
  return "يدرس المستوى";
}

function currentStudy(attempt: StudentStudyAttempt) {
  return attempt.status === "active" && Boolean(attempt.current_group_name || (attempt.latest_waitlist && !attempt.latest_waitlist.left_on));
}

export function StudentStudyTab({ context, search }: { context: StudentContext; search: string }) {
  const router = useRouter();
  const student = context.students[0];
  const study = context.study!;
  const base = `/admin/students/${student.id}?tab=study`;
  const href = (page: number, q = search) => `${base}${page > 1 ? `&study_page=${page}` : ""}${q ? `&study_q=${encodeURIComponent(q)}` : ""}`;
  const canManage = (branchId: number) => context.permissions.can_manage_center ||
    context.permissions.branch_actions?.[String(branchId)]?.includes("enrollment.manage");

  return <section className="form-stack" aria-label="دراسة الطالب">
    <h2>الدراسة</h2>
    <p className="muted">حالة الملف مستقلة عن حالة كل محاولة دراسة. يظهر تاريخ المجموعات التي شارك فيها الطالب في الفروع المصرح بها فقط.</p>
    {student.status === "suspended" ? <InlineNotice tone="warning">الملف موقوف حاليًا. تظل التسجيلات والانتظار والنقل والانسحاب وقرارات الإتمام محفوظة كما هي.</InlineNotice> : null}
    <DataTable id="student-study-attempts" title="محاولات الدراسة" rows={study.attempts} rowKey={attempt => attempt.period_id}
      description="المحاولات والمجموعات الحالية والسابقة، حتى ٢٠ سجلًا في كل دفعة."
      searchText={attempt => `${attempt.course_name} ${attempt.level_name} ${attempt.branch_name} ${attempt.current_group_name ?? ""}`}
      serverSearch={{ value: search, onSearch: value => router.push(href(1, value)) }}
      emptyMessage={search.trim() ? "لا توجد محاولات تطابق البحث." : "لا توجد محاولات دراسة في الفروع المصرح بها."}
      pageSize={20}
      serverPagination={{ page: study.pagination.page, hasMore: study.pagination.has_more, batchSize: 20,
        previousHref: href(Math.max(1, study.pagination.page - 1)), nextHref: href(study.pagination.page + 1) }}
      columns={[
        { key: "course", label: "الكورس والمستوى", render: attempt => <><strong>{attempt.course_name}</strong><br />{attempt.level_name}</> },
        { key: "branch", label: "الفرع", render: attempt => attempt.branch_name },
        { key: "group", label: "المجموعة", render: attempt => attempt.current_group_name ?? attempt.previous_group_name ?? "لم يلتحق بمجموعة" },
        { key: "status", label: "حالة المحاولة", render: attemptStatus },
        { key: "links", label: "الرحلة", actions: true, render: attempt => <div className="flex flex-wrap gap-2">
          {currentStudy(attempt) && canManage(attempt.branch_id) ? <Link href={`/admin/students/${student.id}/enrollments?attempt_id=${attempt.id}`}>فتح التسجيل</Link> : null}
          {currentStudy(attempt) ? <Link href={`/admin/students/${student.id}/courses/${attempt.course_id}/completion`}>إتمام الكورس</Link> : null}
          {!currentStudy(attempt) ? <span className="muted">سجل تاريخي لهذا الفرع</span> : null}
        </div> },
      ]}
      expanded={attempt => <div className="space-y-2">
        <p>بدأت المشاركة في المجموعة: {attempt.joined_on}.</p>
        {attempt.left_on ? <p>انتهت المشاركة في المجموعة: {attempt.left_on}.</p> : null}
        {attempt.latest_waitlist ? <p>{attempt.latest_waitlist.left_on ? "انتظار سابق" : "في الانتظار منذ"}: {attempt.latest_waitlist.entered_on}{attempt.latest_waitlist.left_on ? ` · انتهى ${attempt.latest_waitlist.left_on}` : ""}.</p> : null}
        {attempt.last_visible_transfer_on ? <p>آخر نقل ظاهر بين فروعك: {attempt.last_visible_transfer_on}.</p> : null}
        {attempt.withdrawn_on ? <p>تاريخ الانسحاب: {attempt.withdrawn_on}.</p> : null}
        {attempt.approved_at ? <p>قرار إتمام محفوظ: {new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeZone: "Africa/Cairo" }).format(new Date(attempt.approved_at))}{attempt.exceptional ? " · استثنائي" : ""}.</p> : null}
      </div>} />
  </section>;
}
