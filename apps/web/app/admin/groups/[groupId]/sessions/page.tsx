import type { Metadata } from "next";
import { GroupSessionsPageData } from "./GroupSessionsPageData";

export const metadata: Metadata = { title: "جدول محاضرات المجموعة | Courses" };

export default function GroupSessionsPage(props: {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <GroupSessionsPageData {...props} />;
}
