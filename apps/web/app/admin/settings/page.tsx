import { loadCenterContext } from "@/lib/server-context";
import { notFound } from "next/navigation";
import { SettingsWorkspace } from "./SettingsWorkspace";
import { CenterAccessState } from "@/components/CenterAccessState";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const context = await loadCenterContext("settings");
  if (typeof context === "string") return <CenterAccessState state={context} />;
  if (!context.permissions.can_manage_center) notFound();
  return <SettingsWorkspace centerName={context.center.name} initialSettings={context.settings ?? { contact_email: null, phone: null, address: null }} />;
}
