import type { Metadata } from "next";
import type { ComponentProps } from "react";
import { MembersPageData } from "./MembersPageData";

export const metadata: Metadata = { title: "موظفو المركز | Courses" };

export default function MembersPage(props: ComponentProps<typeof MembersPageData>) {
  return <MembersPageData {...props} />;
}
