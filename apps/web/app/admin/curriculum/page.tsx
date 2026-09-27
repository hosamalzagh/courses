import type { Metadata } from "next";
import type { ComponentProps } from "react";
import { CurriculumPageData } from "./CurriculumPageData";

export const metadata: Metadata = { title: 'منهج الفرع | Courses' };

export default function CurriculumPage(props: ComponentProps<typeof CurriculumPageData>) {
  return <CurriculumPageData {...props} />;
}
