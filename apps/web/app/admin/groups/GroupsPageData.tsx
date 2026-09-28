import "server-only";
import { CenterAccessState } from "@/components/CenterAccessState";
import { CenterPage } from "@/components/CenterPage";
import { loadGroupWorkspace } from "@/lib/server-context";
import { GroupControls } from "./GroupControls";

export async function GroupsPageData({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["page", "levels_page", "instructors_page"]) {
    if (typeof params[key] === "string") query.set(key, params[key]);
  }
  const context = await loadGroupWorkspace(query.toString());
  if (typeof context === "string") return <CenterAccessState state={context} />;
  return <CenterPage context={context} path="/admin/groups"><GroupControls context={context} /></CenterPage>;
}
