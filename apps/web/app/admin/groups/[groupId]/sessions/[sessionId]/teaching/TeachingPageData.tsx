import "server-only";
import { CenterAccessState } from "@/components/CenterAccessState";
import { CenterPage } from "@/components/CenterPage";
import { loadGroupTeaching } from "@/lib/server-context";
import { TeachingControls } from "./TeachingControls";

export async function TeachingPageData({ params }: { params: Promise<{ groupId: string; sessionId: string }> }) {
  const { groupId, sessionId } = await params;
  const context = await loadGroupTeaching(groupId, sessionId);
  if (typeof context === "string") return <CenterAccessState state={context} />;
  return <CenterPage context={context} path={`/admin/groups/${groupId}/sessions/${sessionId}/teaching`}>
    <TeachingControls key={context.session.id} context={context} />
  </CenterPage>;
}
