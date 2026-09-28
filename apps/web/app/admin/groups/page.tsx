import type { Metadata } from "next";
import { GroupsPageData } from "./GroupsPageData";

export const metadata: Metadata = { title: "المجموعات الدراسية | Courses" };

export default function GroupsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <GroupsPageData {...props} />;
}
