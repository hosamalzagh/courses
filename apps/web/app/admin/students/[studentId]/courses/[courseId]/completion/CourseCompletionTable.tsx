"use client";

import { useRouter } from "next/navigation";
import { DataTable } from "@/components/DataTable";
import type { CourseCompletionContext } from "@/lib/server-context";

type Level = CourseCompletionContext["levels"][number];

function status(level: Level) {
  const attempt = level.attempt;
  if (!attempt) return "لم يبدأ هذا المستوى";
  if (attempt.status === "completed" && attempt.approved_at) return attempt.exceptional
    ? "مكتمل استثنائيًا بقرار محفوظ" : "مكتمل بقرار محفوظ";
  if (attempt.status === "withdrawn") return "انسحب من هذا المستوى";
  return "يدرس هذا المستوى؛ لم يعتمد إتمامه بعد";
}

function approval(level: Level) {
  const attempt = level.attempt;
  if (!attempt?.approved_at || attempt.status !== "completed") return "—";
  const date = new Intl.DateTimeFormat("ar-EG", { timeZone: "Africa/Cairo", dateStyle: "medium" }).format(new Date(attempt.approved_at));
  return `${date} · ${attempt.approved_by_name ?? "موظف المركز"}`;
}

export function CourseCompletionTable({ context, search }: { context: CourseCompletionContext; search: string }) {
  const router = useRouter();
  const { course, student, levels, pagination } = context;
  const base = `/admin/students/${student.id}/courses/${course.id}/completion`;
  const href = (page: number, q = search) => {
    const params = new URLSearchParams();
    if (page > 1) params.set("page", String(page));
    if (q) params.set("q", q);
    return `${base}${params.size ? `?${params}` : ""}`;
  };
  return <>
    <section className="context-card form-stack" aria-label="ملخص إتمام الكورس">
      <p><strong>{student.name}</strong> · رقم {student.student_number.toLocaleString("ar-EG")} · {course.name} · فرع {course.branch_name}</p>
      <p role="status"><strong>{course.completed ? "اكتمل الكورس دراسيًا" : "الكورس لم يكتمل دراسيًا"}</strong> · {course.completed_levels.toLocaleString("ar-EG")} من {course.required_levels.toLocaleString("ar-EG")} مستوى مطلوب.</p>
      {course.required_levels === 0 ? <p className="muted">لم تُنشأ مستويات لهذا الكورس بعد.</p> : null}
      <p className="muted">يُحسب كل مستوى على حدة من قرار الإتمام المحفوظ. زيادة حضور مستوى لا تعوّض مستوى آخر، والإتمام الاستثنائي يبقي النسبة والسبب الحقيقيين.</p>
    </section>
    <DataTable id="course-completion-levels" title="المستويات المطلوبة" rows={levels} rowKey={level => level.id}
      description="جميع مستويات الكورس ضمن الفرع المصرح به. تُعرض حتى ٥٠ في الدفعة الحالية."
      emptyMessage="لا توجد مستويات مطلوبة في هذا الكورس."
      searchText={level => `${level.stage_name} ${level.name}`}
      serverSearch={{ value: search, onSearch: value => router.push(href(1, value)) }}
      serverPagination={{ page: pagination.page, hasMore: pagination.has_more, batchSize: 50,
        previousHref: href(Math.max(1, pagination.page - 1)), nextHref: href(pagination.page + 1) }}
      columns={[
        { key: "stage", label: "المرحلة الدراسية", render: level => level.stage_name },
        { key: "level", label: "المستوى", render: level => level.name },
        { key: "status", label: "حالة الإتمام", render: status },
        { key: "approval", label: "القرار وتاريخه", render: approval },
      ]}
      expanded={level => level.attempt?.approved_at && level.attempt.status === "completed" ? <div className="form-stack">
        <p>الاستيفاء المعتمد: {level.attempt.covered_count?.toLocaleString("ar-EG") ?? "٠"} من {level.attempt.required_count?.toLocaleString("ar-EG") ?? "٠"} محاضرة · الحد المطلوب {level.attempt.completion_threshold?.toLocaleString("ar-EG") ?? "٠"}%.</p>
        {level.attempt.exceptional ? <p><strong>سبب الإتمام الاستثنائي:</strong> {level.attempt.reason}</p> : null}
        {level.attempt.group_name ? <p className="muted">المجموعة: {level.attempt.group_name}</p> : null}
      </div> : null} />
  </>;
}
