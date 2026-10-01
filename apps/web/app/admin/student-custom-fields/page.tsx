import { redirect } from "next/navigation";
export const metadata = { title: "الحقول الإضافية للطالب | Courses" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; workspace?: string }>;
}) {
  const { page, workspace } = await searchParams;
  const query = new URLSearchParams({ tab: "student-fields" });
  if (page) query.set("page", page);
  if (workspace) query.set("workspace", workspace);
  redirect(`/admin/settings?${query}`);
}
