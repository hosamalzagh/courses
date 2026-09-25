import { loadCenterContext } from "@/lib/server-context";
import { notFound } from "next/navigation";
import { AuditWorkspace } from "./AuditWorkspace";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const context = await loadCenterContext("audit");
  if (context === "unavailable") return <main className="state-page"><h1>المركز غير متاح الآن</h1></main>;
  if (context === "forbidden") return <main className="state-page"><h1>عضويتك غير متاحة</h1></main>;
  if (!context.permissions.can_manage_center && !Object.values(context.permissions.branch_roles)
    .some((roles) => roles.includes("branch_auditor"))) notFound();
  return <AuditWorkspace centerName={context.center.name} initialEntries={context.audit_entries ?? []} />;
}
