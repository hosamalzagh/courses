import "server-only";
import { CenterPage } from "@/components/CenterPage";
import { loadCenterContext } from "@/lib/server-context";
import { CenterAccessState } from "@/components/CenterAccessState";

export async function AdminPageData() {
  const context = await loadCenterContext();

  if (typeof context === "string") return <CenterAccessState state={context} />;

  return <CenterPage context={context} path="/admin">{null}</CenterPage>;
}
