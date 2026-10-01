import type { ComponentProps } from "react";
import { CenterPage } from "@/components/CenterPage";
import { InstructorControls } from "./InstructorControls";

export function InstructorWorkspace(props: ComponentProps<typeof InstructorControls>) {
  return <CenterPage context={props.context} path="/admin/instructors">
    <InstructorControls key={props.context.workspace?.id ?? "center"} {...props} />
  </CenterPage>;
}
