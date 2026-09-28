import type { Metadata } from "next";
import { CoveragePageData } from "./CoveragePageData";

export const metadata: Metadata = { title: "تغطية المحتوى وأهلية الإتمام | Courses" };

export default function CoveragePage(props: {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <CoveragePageData {...props} />;
}
