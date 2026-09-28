import "server-only";
import { CenterAccessState } from "@/components/CenterAccessState";
import { CenterPage } from "@/components/CenterPage";
import { loadGroupCoverage } from "@/lib/server-context";
import { CoverageControls } from "./CoverageControls";

export async function CoveragePageData({ params, searchParams }: {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ groupId }, query] = await Promise.all([params, searchParams]);
  const page = typeof query.page === "string" ? query.page : "";
  const search = typeof query.q === "string" ? query.q : "";
  const context = await loadGroupCoverage(groupId,
    new URLSearchParams({ ...(page ? { page } : {}), ...(search ? { q: search } : {}) }).toString());
  if (typeof context === "string") return <CenterAccessState state={context} />;
  return <CenterPage context={context} path={`/admin/groups/${groupId}/coverage`}>
    <CoverageControls context={context} search={search} />
  </CenterPage>;
}
