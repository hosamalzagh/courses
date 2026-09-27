import "server-only";
import { BranchWorkspace } from "./BranchWorkspace";
import { loadCenterContext } from "@/lib/server-context";
import { CenterAccessState } from "@/components/CenterAccessState";

export async function AdminPageData() {
  const context = await loadCenterContext();

  if (typeof context === "string") return <CenterAccessState state={context} />;

  return <BranchWorkspace context={context} />;
}
