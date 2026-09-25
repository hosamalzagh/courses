import { loadMemberWorkspace } from "@/lib/server-context";
import { notFound, redirect } from "next/navigation";
import { MemberWorkspace } from "./MemberWorkspace";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const context = await loadMemberWorkspace();
  if (context === "unavailable") return <main className="state-page"><h1>المركز غير متاح الآن</h1></main>;
  if (context === "forbidden") return <main className="state-page"><h1>عضويتك غير متاحة</h1></main>;
  if (!context.permissions.can_manage_center) notFound();
  if (context.membership.status !== "active") redirect("/login");
  return <MemberWorkspace context={context} />;
}
