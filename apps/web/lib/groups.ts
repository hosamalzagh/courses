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
export type StudySession = {
  id: string; number: number; title: string | null; scheduled_at: string;
  status: "planned" | "held" | "cancelled"; revision: number;
  plan_lecture_number: number; content: string;
};
export type SessionContext = CenterContext & {
  group: { id: string; name: string; status: StudyGroup["status"]; revision: number;
    plan_version_id: string; branch_id: number; level_name: string; can_manage: boolean;
    requirements: { number: number; title: string | null; content: string }[];
    scheduled_requirements: number[] };
  sessions: StudySession[];
  pagination: { page: number; has_more: boolean };
};

export type AttendanceRow = {
  attempt_id: string; student_id: string; name: string; student_number: number;
  student_status: "active" | "suspended"; entry_id: string | null;
  status: "counted" | "not_counted" | "absent" | null;
  entry_revision: number | null; recorded_by: number | null;
  suspended_at: string | null; lifted_at: string | null;
};

export type AttendanceContext = CenterContext & {
  group: { id: string; name: string; branch_id: number };
  session: { id: string; group_id: string; number: number; title: string | null; scheduled_at: string;
    status: "planned" | "held" | "cancelled"; revision: number; closed_at: string | null; closed_by: number | null };
  students: AttendanceRow[];
  pagination: { page: number; has_more: boolean };
  can_record: boolean; can_close: boolean; can_undo_own: boolean;
  has_started: boolean;
  last_own_attempt_id: string | null;
};

export type CoverageRow = {
  attempt_id: string; student_id: string; name: string; student_number: number;
  joined_on: string; attempt_status: string; student_status: "active" | "suspended";
  covered_numbers: number[]; missing_numbers: number[]; open_numbers: number[];
  covered_count: number; required_count: number; percentage: number; eligible: boolean;
};

export type CoverageContext = CenterContext & {
  group: { id: string; name: string; status: StudyGroup["status"]; branch_id: number;
    completion_threshold: number; required_count: number;
    requirements: { number: number; title: string | null; content: string }[] };
  students: CoverageRow[];
  pagination: { page: number; has_more: boolean };
};
