import { loadCenterContext } from "@/lib/server-context";
import { notFound } from "next/navigation";
import { SettingsWorkspace } from "./SettingsWorkspace";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const context = await loadCenterContext("settings");
  if (context === "unavailable") return <main className="state-page"><h1>المركز غير متاح الآن</h1></main>;
  if (context === "forbidden") return <main className="state-page"><h1>عضويتك غير متاحة</h1></main>;
  if (!context.permissions.can_manage_center) notFound();
  return <SettingsWorkspace centerName={context.center.name} initialSettings={context.settings ?? { contact_email: null, phone: null, address: null }} />;
}
