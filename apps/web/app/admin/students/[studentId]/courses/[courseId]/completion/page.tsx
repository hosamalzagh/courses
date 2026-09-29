import type { Metadata } from "next";
import type { ComponentProps } from "react";
import { CourseCompletionPageData } from "./CourseCompletionPageData";

export const metadata: Metadata = { title: "حالة إتمام الكورس | Courses" };

export default function CourseCompletionPage(props: ComponentProps<typeof CourseCompletionPageData>) {
  return <CourseCompletionPageData {...props} />;
}
