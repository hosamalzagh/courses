import type { ComponentProps } from 'react';
import { CenterPage } from '@/components/CenterPage';
import { StudentControls } from './StudentControls';

export function StudentWorkspace(props: ComponentProps<typeof StudentControls>) {
  return <CenterPage context={props.context} path='/admin/students'><StudentControls key={props.context.workspace?.id ?? "center"} {...props} /></CenterPage>;
}
