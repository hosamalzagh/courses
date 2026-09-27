import type { ComponentProps } from "react";
import { CenterPage } from "@/components/CenterPage";
import { BranchControls } from "./BranchControls";

export function BranchWorkspace(props: ComponentProps<typeof BranchControls>) {
  return <CenterPage context={props.context} path="/admin">
    <BranchControls {...props} />
  </CenterPage>;
}
