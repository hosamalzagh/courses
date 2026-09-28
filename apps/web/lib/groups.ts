import type { CenterContext } from "./server-context";

export type StudyGroup = {
  id: string; level_id: string; plan_version_id: string; plan_version: number;
  name: string; status: "waiting" | "started" | "completed"; approved_price: string;
  completion_threshold: number; completion_threshold_override: number | null;
  approved_lecture_count: number; revision: number; started_at: string | null;
  branch_id: number; branch_name: string; course_name: string; stage_name: string; level_name: string;
  instructors: { id: string; name: string }[]; can_manage: boolean;
  approved_lectures?: { number: number; content: string; title: string | null; planned_hours: number }[];
};
export type GroupPlanChoice = {
  plan_version_id: string; plan_version: number; level_id: string; level_name: string;
  branch_id: number; branch_name: string; course_name: string; stage_name: string;
  completion_threshold: number;
};
export type GroupInstructorChoice = { id: string; name: string; branch_id: number };
export type GroupContext = CenterContext & {
  groups: StudyGroup[]; level_choices: GroupPlanChoice[];
  pagination: {
    groups: { page: number; has_more: boolean };
    levels: { page: number; has_more: boolean };
  };
};
