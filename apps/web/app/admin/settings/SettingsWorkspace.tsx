import type { ComponentProps } from "react";
import { CenterPage } from "@/components/CenterPage";
import { SettingsControls } from "./SettingsControls";

export function SettingsWorkspace(props: ComponentProps<typeof SettingsControls>) {
  return <CenterPage context={props.context} path="/admin/settings">
    <SettingsControls {...props} />
  </CenterPage>;
}
