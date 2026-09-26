import type { Metadata } from "next";
import { loadCenterContext } from "@/lib/server-context";
import { notFound } from "next/navigation";
import { SettingsWorkspace } from "./SettingsWorkspace";
import { CenterAccessState } from "@/components/CenterAccessState";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "إعدادات المركز | Courses" };

export default async function SettingsPage() {
  const context = await loadCenterContext("settings");
  if (typeof context === "string") return <CenterAccessState state={context} />;
  if (!context.permissions.can_manage_center) notFound();
  return <SettingsWorkspace context={context} initialSettings={context.settings ?? { contact_email: null, phone: null, address: null }} />;
}
