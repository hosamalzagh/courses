import { loadMemberWorkspace } from "@/lib/server-context";
import { notFound, redirect } from "next/navigation";
import { MemberWorkspace } from "./MemberWorkspace";
import { CenterAccessState } from "@/components/CenterAccessState";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const context = await loadMemberWorkspace();
  if (typeof context === "string") return <CenterAccessState state={context} />;
  if (!context.permissions.can_manage_center) notFound();
  if (context.membership.status !== "active") redirect("/login");
  return <MemberWorkspace context={context} />;
}
