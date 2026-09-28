import type { Metadata } from "next";
import type { ComponentProps } from "react";
import { StudentAccountPageData } from "./StudentAccountPageData";

export const metadata: Metadata = { title: "حساب الطالب | Courses" };

export default function StudentAccountPage(props: ComponentProps<typeof StudentAccountPageData>) {
  return <StudentAccountPageData {...props} />;
}
