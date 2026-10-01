import "server-only";
import { CenterAccessState } from "@/components/CenterAccessState";
import { CenterPage } from "@/components/CenterPage";
import { loadGroupSessions } from "@/lib/server-context";
import { curriculumTrail } from "@/lib/curriculum-navigation";
import { SessionControls } from "./SessionControls";

export async function GroupSessionsPageData({ params, searchParams }: {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const page = typeof query.page === "string" ? `page=${encodeURIComponent(query.page)}` : "";
  const context = await loadGroupSessions(groupId, page);
  if (typeof context === "string") return <CenterAccessState state={context} />;
  const g = context.group;
  const trail = curriculumTrail({ id: g.course_id, name: g.course_name }, { id: g.stage_id, name: g.stage_name }, { id: g.level_id, name: g.level_name });
  return <CenterPage context={context} path={`/admin/groups/${groupId}/sessions`} title="جدول محاضرات المجموعة" trail={trail}>
    <SessionControls context={context} />
  </CenterPage>;
}
