import type { Metadata } from "next";
import type { ComponentProps } from "react";
import { StudentPageData } from "./StudentPageData";

export const metadata: Metadata = { title: 'ملف الطالب | Courses' };

export default function StudentPage(props: ComponentProps<typeof StudentPageData>) {
  return <StudentPageData {...props} />;
}
