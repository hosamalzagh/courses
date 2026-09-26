import { loadMemberWorkspace } from "@/lib/server-context";
import { notFound, redirect } from "next/navigation";
import { MemberWorkspace } from "./MemberWorkspace";
import { CenterAccessState } from "@/components/CenterAccessState";

export const dynamic = "force-dynamic";

export default async function MembersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["members_page", "invitations_page", "branches_page"]) {
    if (typeof params[key] === "string") query.set(key, params[key]);
  }
  const context = await loadMemberWorkspace(query.toString());
  if (typeof context === "string") return <CenterAccessState state={context} />;
  if (!context.permissions.can_manage_center) notFound();
  if (context.membership.status !== "active") redirect("/login");
  return <MemberWorkspace context={context} />;
}
