import type { Metadata } from "next";
import { AuditPageData } from "./AuditPageData";

export const metadata: Metadata = { title: "سجل التدقيق | Courses" };

export default function AuditPage() {
  return <AuditPageData />;
}
