import type { CenterContext } from "./server-context";
import type { Course, Stage, Level, CurriculumContext } from "./curriculum";
import type { StudyGroup, GroupContext, SessionContext } from "./groups";

export type CurriculumNodeKind = "course" | "stage" | "level" | "group";
export type CurriculumPathItem = { kind: CurriculumNodeKind; id: string; name: string };
export type CurriculumNode = CurriculumPathItem & {
  branch_id: number;
  child_count: number;
  can_manage: boolean;
  path: CurriculumPathItem[];
  record: Course | Stage | Level | StudyGroup;
};
export type CurriculumTreeBatch = {
  parent: CurriculumNode | null;
  items: CurriculumNode[];
  page: number;
  has_more: boolean;
};
export type CurriculumTree = {
  root: CurriculumTreeBatch;
  path: CurriculumNode[];
  batches: CurriculumTreeBatch[];
  search: { q: string; items: CurriculumNode[]; page: number; has_more: boolean };
};
export type CurriculumExplorerContext = CenterContext & {
  tree: CurriculumTree;
  students?: { items: { attempt_id: string; student_id: string; name: string; student_number: number; student_status: string; status: string; joined_on: string }[]; pagination: { page: number; has_more: boolean } };
  curriculum?: Omit<CurriculumContext, keyof CenterContext>;
  groups?: Omit<GroupContext, keyof CenterContext>;
  session?: Omit<SessionContext, keyof CenterContext>;
};
export const curriculumNodeLabels: Record<CurriculumNodeKind, string> = {
  course: "الكورس", stage: "المرحلة الدراسية", level: "المستوى", group: "المجموعة",
};
export function curriculumNodeKey(node: CurriculumPathItem): string {
  return `${node.kind}:${node.id}`;
}
export function curriculumExplorerHref(node: CurriculumPathItem | null, current = "", intent?: string): string {
  const params = new URLSearchParams(current);
  const previousKind = params.get("kind") ?? (params.has("stage_id") ? "stage" : params.has("course_id") ? "course" : null);
  const previousId = params.get("id") ?? params.get("stage_id") ?? params.get("course_id");
  const changed = previousKind !== (node?.kind ?? null) || previousId !== (node?.id ?? null);
  for (const key of ["kind", "id", "course_id", "stage_id", "level_id", "tab", "intent"]) params.delete(key);
  if (changed) for (const key of ["stages_page", "levels_page", "groups_page", "plan_version", "versions_page", "sessions_page", "students_page"]) params.delete(key);
  if (node) { params.set("kind", node.kind); params.set("id", node.id); }
  if (intent) params.set("intent", intent);
  return `/admin/curriculum${params.size ? `?${params}` : ""}`;
}
