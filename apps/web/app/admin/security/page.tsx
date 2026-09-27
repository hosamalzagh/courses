import type { Metadata } from "next";
import { SecurityPageData } from "./SecurityPageData";

export const metadata: Metadata = { title: "أمان الحساب | Courses" };

export default function SecurityPage() {
  return <SecurityPageData />;
}
