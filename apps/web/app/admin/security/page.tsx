import { loadCenterContext } from "@/lib/server-context";
import { SecurityWorkspace } from "./SecurityWorkspace";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const context = await loadCenterContext();
  if (context === "unavailable") return <main className="state-page"><h1>المركز غير متاح الآن</h1></main>;
  if (context === "forbidden") return <main className="state-page"><h1>عضويتك غير متاحة</h1></main>;

  return <SecurityWorkspace
    centerName={context.center.name}
    email={context.user.email}
    initialEnabled={context.user.mfa_enabled ?? false}
    requiredForPlatform={context.user.mfa_required_for_platform ?? false}
  />;
}
