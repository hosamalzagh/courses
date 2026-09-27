import type { ComponentProps } from "react";
import { CenterPage } from "@/components/CenterPage";
import { MemberControls } from "./MemberControls";
import styles from "./MemberWorkspace.module.css";

export function MemberWorkspace(props: ComponentProps<typeof MemberControls>) {
  return <CenterPage context={props.context} path="/admin/members" className={styles.workspace}>
    <details className="context-card"><summary>مصفوفة الأدوار والإجراءات</summary>
      <p>مالك المركز ومسؤوله يحتفظان بصلاحياتهما على جميع الفروع. الأدوار التالية تُجمع لكل فرع، ومنح الاعتماد المالي للمالك فقط.</p>
      <dl>{Object.entries(props.context.grant_options).map(([role, option]) => <div key={role}><dt><strong>{option.label}</strong></dt><dd>{option.description}</dd></div>)}</dl>
    </details>
    <MemberControls {...props} />
  </CenterPage>;
}
