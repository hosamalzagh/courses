import type { Metadata } from "next";
import { CenterAccessState } from "@/components/CenterAccessState";
import { CenterPage } from "@/components/CenterPage";
import { loadAbsenceReview } from "@/lib/server-context";
import { AbsenceReviewControls } from "./AbsenceReviewControls";

export const metadata: Metadata = { title: "مراجعة الغياب | Courses" };

export default async function AbsenceReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const key of ["branch_id", "course_id", "stage_id", "level_id", "group_id", "view", "page", "q"]) {
    if (typeof params[key] === "string") query.set(key, params[key]);
  }
  const context = await loadAbsenceReview(query.toString());
  if (typeof context === "string") return <CenterAccessState state={context} />;
  return <CenterPage context={context} path="/admin/absence-review"><AbsenceReviewControls key={query.toString()} context={context} filters={Object.fromEntries(query)} /></CenterPage>;
}
