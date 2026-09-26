import type { CenterContext } from './server-context';
export type PlanLecture = { id?: string; number: number; content: string; title: string | null; planned_hours: number };
export type StudyPlan = { id: string; version: number; revision: number; used_at: string | null; lecture_count: number; planned_hours: number; lectures: PlanLecture[] };
export type Course = { id: string; branch_id: number; name: string; can_manage: boolean };
export type Stage = { id: string; course_id: string; branch_id: number; name: string; course_name: string; can_manage: boolean };
export type Level = { id: string; stage_id: string; course_id: string; branch_id: number; name: string; stage_name: string; course_name: string; can_manage: boolean; plan: StudyPlan };
export type CurriculumContext = CenterContext & { courses: Course[]; stages: Stage[]; levels: Level[]; pagination: { courses: { page: number; has_more: boolean }; stages: { page: number; has_more: boolean }; levels: { page: number; has_more: boolean }; branches: { page: number; has_more: boolean } } };
