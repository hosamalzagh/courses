import type { Metadata } from "next";
import type { ComponentProps } from "react";
import { StudentEnrollmentsPageData } from "./StudentEnrollmentsPageData";

export const metadata: Metadata = { title: "تسجيل الطالب | Courses" };

export default function StudentEnrollmentsPage(props: ComponentProps<typeof StudentEnrollmentsPageData>) {
  return <StudentEnrollmentsPageData {...props} />;
}
