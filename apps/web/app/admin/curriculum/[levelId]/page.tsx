import type { Metadata } from "next";
import type { ComponentProps } from "react";
import { PlanPageData } from "./PlanPageData";

export const metadata: Metadata = { title: 'خطة المستوى | Courses' };

export default function PlanPage(props: ComponentProps<typeof PlanPageData>) {
  return <PlanPageData {...props} />;
}
