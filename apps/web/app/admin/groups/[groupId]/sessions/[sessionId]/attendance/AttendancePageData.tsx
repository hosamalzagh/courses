import "server-only";
import { CenterAccessState } from "@/components/CenterAccessState";
import { CenterPage } from "@/components/CenterPage";
import { loadGroupAttendance } from "@/lib/server-context";
import { AttendanceControls } from "./AttendanceControls";

export async function AttendancePageData({ params, searchParams }: {
  params: Promise<{ groupId: string; sessionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ groupId, sessionId }, query] = await Promise.all([params, searchParams]);
  const page = typeof query.page === "string" ? query.page : "";
  const search = typeof query.q === "string" ? query.q : "";
  const context = await loadGroupAttendance(groupId, sessionId,
    new URLSearchParams({ ...(page ? { page } : {}), ...(search ? { q: search } : {}) }).toString());
  if (typeof context === "string") return <CenterAccessState state={context} />;
  return <CenterPage context={context} path={`/admin/groups/${groupId}/sessions/${sessionId}/attendance`}>
    <AttendanceControls context={context} search={search} />
  </CenterPage>;
}
