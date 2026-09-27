import type { Metadata } from "next";
import type { ComponentProps } from "react";
import { StudentsPageData } from "./StudentsPageData";

export const metadata: Metadata = { title: 'ملفات الطلاب | Courses' };

export default function StudentsPage(props: ComponentProps<typeof StudentsPageData>) {
  return <StudentsPageData {...props} />;
}
