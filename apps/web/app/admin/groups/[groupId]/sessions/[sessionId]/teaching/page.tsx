import type { Metadata } from "next";
import { TeachingPageData } from "./TeachingPageData";

export const metadata: Metadata = { title: "التدريس الفعلي للمحاضرة | Courses" };

export default function TeachingPage(props: { params: Promise<{ groupId: string; sessionId: string }> }) {
  return <TeachingPageData {...props} />;
}
