import "server-only";
import { CenterAccessState } from "@/components/CenterAccessState";
import { CenterPage } from "@/components/CenterPage";
import { loadGroupSessions } from "@/lib/server-context";
import { SessionControls } from "./SessionControls";

export async function GroupSessionsPageData({ params, searchParams }: {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const page = typeof query.page === "string" ? `page=${encodeURIComponent(query.page)}` : "";
  const context = await loadGroupSessions(groupId, page);
  if (typeof context === "string") return <CenterAccessState state={context} />;
  return <CenterPage context={context} path={`/admin/groups/${groupId}/sessions`}>
    <SessionControls context={context} />
  </CenterPage>;
}
