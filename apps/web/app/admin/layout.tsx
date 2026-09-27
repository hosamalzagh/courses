import type { ReactNode } from "react";
import { CenterLayout } from "@/components/CenterShell";
import { CenterAccessState } from "@/components/CenterAccessState";
import { loadAdminLayoutContext } from "@/lib/server-context";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const context = await loadAdminLayoutContext();
  if (typeof context === "string") return <CenterAccessState state={context} />;
  return <CenterLayout initialContext={context}>{children}</CenterLayout>;
}
