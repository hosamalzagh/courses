import { redirect } from "next/navigation";
export const metadata = { title: "الحقول الإضافية للطالب | Courses" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page } = await searchParams;
  const query = new URLSearchParams({ tab: "student-fields" });
  if (page) query.set("page", page);
  redirect(`/admin/settings?${query}`);
}
