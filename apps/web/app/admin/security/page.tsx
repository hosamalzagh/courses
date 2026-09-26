import type { Metadata } from "next";
import { loadCenterContext } from "@/lib/server-context";
import { SecurityWorkspace } from "./SecurityWorkspace";
import { CenterAccessState } from "@/components/CenterAccessState";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "أمان الحساب | Courses" };

export default async function SecurityPage() {
  const context = await loadCenterContext();
  if (typeof context === "string") return <CenterAccessState state={context} />;

  return <SecurityWorkspace
    context={context}
    email={context.user.email}
    initialEnabled={context.user.mfa_enabled ?? false}
    requiredForPlatform={context.user.mfa_required_for_platform ?? false}
  />;
}
