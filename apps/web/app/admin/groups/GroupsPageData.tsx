import "server-only";
import { CenterAccessState } from "@/components/CenterAccessState";
import { CenterPage } from "@/components/CenterPage";
import { loadGroupWorkspace } from "@/lib/server-context";
import { curriculumTrail } from "@/lib/curriculum-navigation";
import { GroupControls } from "./GroupControls";

export async function GroupsPageData({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["page", "levels_page", "instructors_page", "level_id"]) {
    if (typeof params[key] === "string") query.set(key, params[key]);
  }
  const context = await loadGroupWorkspace(query.toString());
  if (typeof context === "string") return <CenterAccessState state={context} />;
  const n = context.navigation;
  const trail = n ? curriculumTrail({ id: n.course_id, name: n.course_name }, { id: n.stage_id, name: n.stage_name }) : undefined;
  return <CenterPage context={context} path="/admin/groups" title={n ? `مجموعات ${n.level_name}` : undefined} trail={trail}><GroupControls key={n?.level_id ?? "register"} context={context} /></CenterPage>;
}
