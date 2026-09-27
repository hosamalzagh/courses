import type { Metadata } from "next";
import type { ComponentProps } from "react";
import { InstructorPageData } from "./InstructorPageData";

export const metadata: Metadata = { title: 'ملف المحاضر | Courses' };

export default function InstructorPage(props: ComponentProps<typeof InstructorPageData>) {
  return <InstructorPageData {...props} />;
}
