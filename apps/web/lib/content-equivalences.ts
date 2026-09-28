import type { CenterContext } from './server-context';

export type EquivalenceLecture = { id: string; number: number; content: string; title: string | null; planned_hours: number };
export type EquivalenceLectureSnapshot = Pick<EquivalenceLecture, 'number' | 'content' | 'title'>;
export type EquivalencePlan = { id: string; version: number; level_id: string; level_name: string; stage_name: string;
  course_name: string; branch_id: number; branch_name: string; lectures: EquivalenceLecture[] };
export type ContentEquivalence = { id: string; source_plan_version_id: string; target_plan_version_id: string;
  source_lecture_ids: string[]; target_lecture_ids: string[]; source_lectures: EquivalenceLectureSnapshot[];
  target_lectures: EquivalenceLectureSnapshot[]; reason: string; approved_by_id: number;
  approved_by_name: string; approved_at: string; source_branch_id: number; target_branch_id: number;
  source_level_name: string; target_level_name: string; source_version: number; target_version: number };
export type ContentEquivalenceContext = CenterContext & { options: EquivalencePlan[]; options_has_more: boolean; options_page: number;
  approvals: ContentEquivalence[]; pagination: { page: number; has_more: boolean } };
