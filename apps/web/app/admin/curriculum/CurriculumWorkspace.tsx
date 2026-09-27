import type { ComponentProps } from "react";
import { CenterPage } from "@/components/CenterPage";
import { CurriculumControls } from "./CurriculumControls";

export function CurriculumWorkspace(props: ComponentProps<typeof CurriculumControls>) {
  return <CenterPage context={props.context} path={props.detail ? "/admin/curriculum/detail" : "/admin/curriculum"}>
    <CurriculumControls {...props} />
  </CenterPage>;
}
