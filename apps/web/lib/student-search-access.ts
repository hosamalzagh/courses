import type { CenterContext } from "./server-context";

export function canReadStudents(context: CenterContext): boolean {
  return context.permissions.can_manage_center || Object.values(context.permissions.branch_actions ?? {})
    .some((actions) => actions.includes("read"));
}

export function canSearchCenterStudents(context: CenterContext): boolean {
  return context.permissions.can_manage_center || Object.values(context.permissions.branch_actions ?? {})
    .some((actions) => actions.includes("students.search_center"));
}
