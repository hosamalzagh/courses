export type CurriculumTrailItem = { label: string; href: string };
export const courseStagesHref = (id: string) => `/admin/curriculum?tab=stages&course_id=${encodeURIComponent(id)}`;
export const stageLevelsHref = (id: string) => `/admin/curriculum?tab=levels&stage_id=${encodeURIComponent(id)}`;
export const levelGroupsHref = (id: string) => `/admin/groups?level_id=${encodeURIComponent(id)}`;

export function curriculumTrail(course?: { id: string; name: string }, stage?: { id: string; name: string } | null,
  level?: { id: string; name: string }) : CurriculumTrailItem[] {
  return [{ label: 'الكورسات', href: '/admin/curriculum' },
    ...(course ? [{ label: course.name, href: courseStagesHref(course.id) }] : []),
    ...(stage ? [{ label: stage.name, href: stageLevelsHref(stage.id) }] : []),
    ...(level ? [{ label: level.name, href: levelGroupsHref(level.id) }] : [])];
}
