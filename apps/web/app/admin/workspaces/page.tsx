import type { Metadata } from "next";
import { CenterPage } from "@/components/CenterPage";
import { CenterAccessState } from "@/components/CenterAccessState";
import { loadWorkspaceOptions } from "@/lib/server-context";
import { WorkspacePicker } from "./WorkspacePicker";

export const metadata: Metadata = { title: "اختيار مساحة العمل | Courses" };
export default async function WorkspacePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const context = await loadWorkspaceOptions(typeof params.page === "string" ? params.page : "1");
  if (typeof context === "string") return <CenterAccessState state={context} />;
  return <CenterPage context={context} path="/admin/workspaces" title="اختيار مساحة العمل">
    <WorkspacePicker key={context.pagination.page} context={context} expired={params.expired === "1"} returnTo={typeof params.return_to === "string" ? params.return_to : "/admin"} />
  </CenterPage>;
}
