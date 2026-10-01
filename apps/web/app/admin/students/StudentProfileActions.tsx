'use client';

import { workspaceApiHref } from '@/lib/workspace';
import { buttonVariants } from "@/components/ui/button";
import { CenterPageActions } from '@/components/CenterShell';
import type { StudentContext } from '@/lib/server-context';
import { StudentNavigationLink } from './StudentNavigationLink';

export function StudentProfileActions({ context, tab }: { context: StudentContext; tab?: string }) {
  const student = context.students[0];
  const canEnroll = context.permissions.can_manage_center || student.branch_ids.some(id => context.permissions.branch_actions?.[String(id)]?.includes('enrollment.manage'));
  return <CenterPageActions context={context} actions={<>{student.can_manage ? <StudentNavigationLink focusKey='edit' href={`/admin/students/${student.id}/edit`}>تعديل ملف الطالب</StudentNavigationLink> : null}<StudentNavigationLink focusKey='report' href={`/admin/students/${student.id}/report`}>تقرير الطالب</StudentNavigationLink>{tab === 'study' && canEnroll ? <StudentNavigationLink focusKey='enrollments' href={`/admin/students/${student.id}/enrollments`}>فتح التسجيل ومحاولات الدراسة</StudentNavigationLink> : null}<a className={buttonVariants({ variant: 'outline' })} href={workspaceApiHref(`/api/v1/center/students/${student.id}/barcode`, context.workspace?.id)} target='_blank' rel='noopener'>طباعة الباركود الأساسي</a></>} />;
}
