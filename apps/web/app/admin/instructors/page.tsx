import type { Metadata } from "next";
import type { ComponentProps } from "react";
import { InstructorsPageData } from "./InstructorsPageData";

export const metadata: Metadata = { title: 'ملفات المحاضرين | Courses' };

export default function InstructorsPage(props: ComponentProps<typeof InstructorsPageData>) {
  return <InstructorsPageData {...props} />;
}
