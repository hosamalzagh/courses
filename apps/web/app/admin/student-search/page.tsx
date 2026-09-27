import type { Metadata } from "next";
import type { ComponentProps } from "react";
import { StudentSearchPageData } from "./StudentSearchPageData";

export const metadata: Metadata = { title: 'البحث في طلاب المركز | Courses' };

export default function StudentSearchPage(props: ComponentProps<typeof StudentSearchPageData>) {
  return <StudentSearchPageData {...props} />;
}
