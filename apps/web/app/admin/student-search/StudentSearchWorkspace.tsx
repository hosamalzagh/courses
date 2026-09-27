import type { ComponentProps } from "react";
import { CenterPage } from "@/components/CenterPage";
import { StudentSearchControls } from "./StudentSearchControls";

export function StudentSearchWorkspace(props: ComponentProps<typeof StudentSearchControls>) {
  return <CenterPage context={props.context} path="/admin/student-search">
    <StudentSearchControls {...props} />
  </CenterPage>;
}
