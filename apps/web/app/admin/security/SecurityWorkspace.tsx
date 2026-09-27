import type { ComponentProps } from "react";
import { CenterPage } from "@/components/CenterPage";
import { SecurityControls } from "./SecurityControls";

export function SecurityWorkspace(props: ComponentProps<typeof SecurityControls>) {
  return <CenterPage context={props.context} path="/admin/security">
    <SecurityControls {...props} />
  </CenterPage>;
}
