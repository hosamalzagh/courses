import type { CenterSettings, StudentSearchPolicy } from "@/lib/server-context";
import { StudentCodeControls } from "./StudentCodeControls";
import { StudentNumberingControls } from "./StudentNumberingControls";
import { StudentSearchPolicyControls } from "./StudentSearchPolicyControls";

export function StudentSettingsControls({ settings, policy }: { settings: CenterSettings; policy: StudentSearchPolicy }) {
  return <>
    <StudentNumberingControls start={settings.student_number_start ?? 1} revision={settings.student_number_revision ?? 1} />
    <StudentCodeControls settings={settings} />
    <StudentSearchPolicyControls initialPolicy={policy} />
  </>;
}
