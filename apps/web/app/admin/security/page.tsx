import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "أمان الحساب | Courses" };

export default function SecurityPage() {
  redirect("/admin/settings?tab=security");
}
