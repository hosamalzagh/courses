import "server-only";
import { loadCenterContext } from "@/lib/server-context";
import { SecurityWorkspace } from "./SecurityWorkspace";
import { CenterAccessState } from "@/components/CenterAccessState";

export async function SecurityPageData() {
  const context = await loadCenterContext();
  if (typeof context === "string") return <CenterAccessState state={context} />;

  return <SecurityWorkspace
    context={context}
    initialEnabled={context.user.mfa_enabled ?? false}
    requiredForPlatform={context.user.mfa_required_for_platform ?? false}
  />;
}
