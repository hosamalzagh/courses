import type { Metadata } from "next";
import { loadCenterContext } from "@/lib/server-context";
import { notFound } from "next/navigation";
import { AuditWorkspace } from "./AuditWorkspace";
import { CenterAccessState } from "@/components/CenterAccessState";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "سجل التدقيق | Courses" };

export default async function AuditPage() {
  const context = await loadCenterContext("audit");
  if (typeof context === "string") return <CenterAccessState state={context} />;
  if (!context.permissions.can_manage_center && !Object.values(context.permissions.branch_roles)
    .some((roles) => roles.includes("branch_auditor"))) notFound();
  return <AuditWorkspace context={context} initialEntries={context.audit_entries ?? []} />;
}
