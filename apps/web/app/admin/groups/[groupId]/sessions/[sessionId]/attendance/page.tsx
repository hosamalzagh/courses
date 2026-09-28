import type { Metadata } from "next";
import { AttendancePageData } from "./AttendancePageData";

export const metadata: Metadata = { title: "كشف حضور المحاضرة | Courses" };

export default function AttendancePage(props: {
  params: Promise<{ groupId: string; sessionId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <AttendancePageData {...props} />;
}
