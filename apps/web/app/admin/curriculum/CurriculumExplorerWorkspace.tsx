"use client";

import { useId } from "react";
import { useSearchParams } from "next/navigation";
import { CurriculumRecordMenu, canCopyCurriculum, type ManagedCurriculumRecord } from "./CurriculumRecordMenu";
import { curriculumExplorerHref } from "@/lib/curriculum-explorer";
import { CurriculumControls } from "./CurriculumControls";
import { CurriculumExplorer } from "./CurriculumExplorer";
import { GroupRecordMenu } from "../groups/GroupRecordMenu";
import type { StudyGroup } from "@/lib/groups";
import { GroupControls } from "../groups/GroupControls";
import { SessionControls } from "../groups/[groupId]/sessions/SessionControls";
import type { CurriculumContext } from "@/lib/curriculum";
import type { CurriculumExplorerContext } from "@/lib/curriculum-explorer";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { DataTable } from "@/components/DataTable";
import { PrefetchLink } from "@/components/PrefetchLink";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function CurriculumExplorerWorkspace({ context }: { context: CurriculumExplorerContext }) {
  const id = useId();
  const params = useSearchParams();
  const selected = context.tree.path.at(-1);
  const curriculum = context.curriculum ? { ...context, ...context.curriculum } as CurriculumContext : null;
  function studentPageHref(page: number) { const next = new URLSearchParams(params.toString()); if (page > 1) next.set("students_page", String(page)); else next.delete("students_page"); return `/admin/curriculum?${next}`; }
  return <CurriculumExplorer context={context} actions={node => node.kind === "group" ? <GroupRecordMenu compact group={node.record as StudyGroup} sessionsHref={curriculumExplorerHref(node, params.toString())} manageHref={curriculumExplorerHref(node, params.toString(), "group")} /> : node.can_manage || (node.kind === "course" && canCopyCurriculum(context.permissions, node.branch_id)) ? <CurriculumRecordMenu selection={{ kind: node.kind, record: node.record } as ManagedCurriculumRecord} triggerId={`${id}-${node.id}`} compact canCopy={canCopyCurriculum(context.permissions, node.branch_id)} actionHref={action => curriculumExplorerHref(node, params.toString(), action)} onAction={() => {}} /> : null}>
    {curriculum && selected?.kind !== "group" ? <CurriculumControls key={`curriculum:${selected?.id ?? "root"}`} context={curriculum} explorer={selected?.kind ?? "root"} detail={selected?.kind === "level"} section={selected?.kind === "course" ? "stages" : selected?.kind === "stage" ? "levels" : "courses"} /> : null}
    {!selected ? <Empty><EmptyHeader><EmptyTitle>اختر عنصرًا من الشجرة</EmptyTitle><EmptyDescription>يفتح السهم الأبناء، ويعرض الاسم تفاصيل العنصر.</EmptyDescription></EmptyHeader></Empty> : null}
    {context.groups ? <GroupControls key={`groups:${selected?.id}`} explorer={selected?.kind === "group" ? "group" : "level"} context={{ ...context, ...context.groups }} /> : null}
    {context.session ? <>
      <Card size="sm"><CardHeader><CardTitle><bdi>{selected?.name}</bdi></CardTitle></CardHeader><CardContent>جدول محاضرات المجموعة</CardContent></Card>
      {context.students ? <DataTable id="curriculum-group-students" title="طلاب المجموعة" rows={context.students.items} rowKey={row => row.attempt_id} searchText={row => `${row.name} ${row.student_number}`} emptyMessage="لا يوجد طلاب في هذه الدفعة." columns={[
        { key: "name", label: "الطالب", render: row => <PrefetchLink href={`/admin/students/${row.student_id}/report`}>{row.name}</PrefetchLink> },
        { key: "number", label: "رقم الطالب", render: row => row.student_number.toLocaleString("ar-EG") },
        { key: "status", label: "حالة الدراسة", render: row => ({ active: "نشطة", withdrawn: "منسحب", completed: "مكتملة", transferred: "منقول" }[row.status] ?? row.status) },
      ]} serverPagination={{ page: context.students.pagination.page, hasMore: context.students.pagination.has_more, batchSize: 20, previousHref: studentPageHref(Math.max(1, context.students.pagination.page - 1)), nextHref: studentPageHref(context.students.pagination.page + 1) }} /> : null}
      <SessionControls key={`sessions:${selected?.id}`} explorer context={{ ...context, ...context.session }} />
    </> : null}
  </CurriculumExplorer>;
}
