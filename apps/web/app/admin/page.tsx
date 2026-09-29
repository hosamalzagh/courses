import type { Metadata } from "next";
import { AdminPageData } from "./AdminPageData";

export const metadata: Metadata = { title: "الرئيسية | Courses" };

export default function AdminPage() {
  return <AdminPageData />;
}
