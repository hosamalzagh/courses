"use client";

import { CenterPageActions } from "@/components/CenterShell";
import type { StudentSearchContext } from "@/lib/server-context";
import { StudentLookup } from "./StudentLookup";
import { StudentNavigationLink } from "./StudentNavigationLink";

export function StudentCenterSearchControls({ context, query }: { context: StudentSearchContext; query: string }) {
  const canCreate = context.permissions.can_manage_center || Object.values(context.permissions.branch_actions ?? {})
    .some((actions) => actions.includes("students.manage"));
  return <>
    <CenterPageActions context={context} actions={canCreate ? <StudentNavigationLink primary focusKey="create" href="/admin/students/new">إنشاء ملف طالب</StudentNavigationLink> : undefined} />
    <StudentLookup scope="center" context={context} query={query} />
  </>;
}
