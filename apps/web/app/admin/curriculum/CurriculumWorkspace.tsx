import type { ComponentProps } from "react";
import { CenterPage } from "@/components/CenterPage";
import { curriculumTrail } from "@/lib/curriculum-navigation";
import { CurriculumControls } from "./CurriculumControls";

export function CurriculumWorkspace(props: ComponentProps<typeof CurriculumControls>) {
  const n = props.context.navigation;
  const title = props.detail ? `خطة ${props.context.levels[0]?.name ?? 'المستوى'}` : n?.stage ? `مستويات ${n.stage.name}` : n ? `مراحل ${n.course.name}` : undefined;
  const trail = n ? props.detail ? curriculumTrail(n.course, n.stage, props.context.levels[0]) : n.stage ? curriculumTrail(n.course) : curriculumTrail() : undefined;
  return <CenterPage context={props.context} path={props.detail ? "/admin/curriculum/detail" : "/admin/curriculum"} title={title} trail={trail}>
    <CurriculumControls key={`${props.context.workspace?.id ?? "legacy"}:${props.detail ? props.context.levels[0]?.id : n?.stage?.id ?? n?.course.id ?? "register"}`} {...props} />
  </CenterPage>;
}
