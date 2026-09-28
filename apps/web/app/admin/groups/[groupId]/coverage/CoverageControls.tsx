"use client";

import { useRouter } from "next/navigation";
import { CenterPageActions } from "@/components/CenterShell";
import { DataTable } from "@/components/DataTable";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import type { CoverageContext, CoverageRow } from "@/lib/groups";

export function CoverageControls({ context, search }: { context: CoverageContext; search: string }) {
  const router = useRouter();
  const group = context.group;
  const base = `/admin/groups/${group.id}/coverage`;
  const href = (page: number, q = search) => {
    const params = new URLSearchParams();
    if (page > 1) params.set("page", String(page));
    if (q) params.set("q", q);
    return `${base}${params.size ? `?${params}` : ""}`;
  };
  const label = (numbers: number[]) => numbers.length ? numbers.map(number => {
    const requirement = group.requirements.find(item => item.number === number);
    return `${number.toLocaleString("ar-EG")} · ${requirement?.title || requirement?.content || "محاضرة مطلوبة"}`;
  }).join("، ") : "لا يوجد";
  const result = (row: CoverageRow) => {
    if (row.student_status === "suspended") return "تحتاج مراجعة: الطالب موقوف";
    if (row.attempt_status === "withdrawn") return "تحتاج مراجعة: المحاولة منسحب منها";
    if (row.eligible) return row.open_numbers.length ? "مؤهل مبدئيًا — حضور مفتوح" : "بلغ الحد — يحتاج اعتمادًا صريحًا";
    return row.open_numbers.length ? "ناقص — النسبة مبدئية" : "ناقص";
  };

  return <>
    <CenterPageActions context={context} actions={<><Link href={`/admin/groups/${group.id}/sessions`}>جدول محاضرات المجموعة</Link><Link href="/admin/groups">العودة للمجموعات</Link></>} />
    <p className="muted">{group.name} · المطلوب {group.required_count.toLocaleString("ar-EG")} محاضرة · حد التسجيلات الجديدة {group.completion_threshold.toLocaleString("ar-EG")}%.</p>
    <p className="muted">المحاضرات السابقة لانضمام الطالب تبقى ضمن المطلوب، لكنها ليست غيابًا عليه. النسبة هنا لتغطية المحتوى فقط؛ بلوغ الحد لا يعتمد إتمام الدراسة تلقائيًا.</p>
    <DataTable id="study-coverage" title="تقرير أهلية إتمام الدراسة" description="المحتسب من محاضرات الخطة مرة واحدة. الحضور في محاضرة مفتوحة مبدئي حتى الإغلاق." rows={context.students}
      rowKey={row => row.attempt_id} searchText={row => `${row.name} ${row.student_number}`} emptyMessage="لا توجد محاولات دراسة مطابقة في هذه المجموعة."
      serverSearch={{ value: search, onSearch: value => router.push(href(1, value)) }}
      serverPagination={{ page: context.pagination.page, hasMore: context.pagination.has_more, batchSize: 20,
        previousHref: href(context.pagination.page - 1), nextHref: href(context.pagination.page + 1) }}
      columns={[
        { key: "student", label: "الطالب", render: row => <Link href={`/admin/students/${row.student_id}`}>{row.name} · {row.student_number.toLocaleString("ar-EG")}</Link> },
        { key: "coverage", label: "التغطية", render: row => `${row.covered_count.toLocaleString("ar-EG")}/${row.required_count.toLocaleString("ar-EG")} · ${row.percentage.toLocaleString("ar-EG")}%` },
        { key: "missing", label: "الناقص", render: row => row.missing_numbers.length.toLocaleString("ar-EG") },
        { key: "result", label: "أهلية الإتمام", render: result },
      ]}
      expanded={row => <div className="space-y-2"><p><strong>المستوفى:</strong> {label(row.covered_numbers)}</p><p><strong>الناقص:</strong> {label(row.missing_numbers)}</p>
        <p>حد هذه المحاولة: {row.completion_threshold.toLocaleString("ar-EG")}% ({Math.ceil(row.required_count * row.completion_threshold / 100).toLocaleString("ar-EG")} محاضرة كاملة على الأقل).</p>
        {row.open_numbers.length ? <p role="status"><strong>حضور مبدئي في محاضرات مفتوحة:</strong> {label(row.open_numbers)}. قد تتغير النسبة عند التراجع، ولا يجوز اعتماد الإتمام حتى الإغلاق وإعادة المراجعة.</p> : null}
        <p className="muted">تاريخ الانضمام: {row.joined_on} · حالة محاولة الدراسة: {row.attempt_status === "withdrawn" ? "منسحب" : row.attempt_status === "completed" ? "مكتملة" : "نشطة"}</p>
      </div>} />
  </>;
}
