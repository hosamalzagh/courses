import { BranchWorkspace } from "./BranchWorkspace";
import { loadCenterContext } from "@/lib/server-context";
import { CenterAccessState } from "@/components/CenterAccessState";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const context = await loadCenterContext();

  if (typeof context === "string") return <CenterAccessState state={context} />;

  return <BranchWorkspace context={context} />;
}
