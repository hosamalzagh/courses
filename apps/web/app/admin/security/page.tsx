import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "أمان الحساب | Courses" };

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ workspace?: string }> }) {
  const { workspace } = await searchParams;
  const query = new URLSearchParams({ tab: "security" });
  if (workspace) query.set("workspace", workspace);
  redirect(`/admin/settings?${query}`);
}
