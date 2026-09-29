import "server-only";

import { CenterPage } from "@/components/CenterPage";
import type { StudentSearchContext } from "@/lib/server-context";
import { StudentCenterSearchControls } from "./StudentCenterSearchControls";

export function StudentCenterSearchWorkspace({ context, query }: { context: StudentSearchContext; query: string }) {
  return <CenterPage context={context} path="/admin/students">
    <StudentCenterSearchControls context={context} query={query} />
  </CenterPage>;
}
