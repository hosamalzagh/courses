'use client';

import { useWorkspaceId } from '@/components/WorkspaceNavigation';
import { workspaceApiHref } from '@/lib/workspace';
import { ChevronDown } from 'lucide-react';
import { PrefetchLink } from '@/components/PrefetchLink';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Student, StudentContext } from '@/lib/server-context';

export function StudentRowActions({ student, permissions }: {
  student: Student;
  permissions: StudentContext['permissions'];
}) {
  const workspaceId = useWorkspaceId();
  const profile = `/admin/students/${student.id}`;
  const canReadFinance = permissions.can_manage_center || student.branch_ids.some((id) =>
    permissions.branch_actions?.[String(id)]?.includes('finance.read'));

  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant='outline' size='sm' />} aria-label={`إجراءات الطالب ${student.name}`}>
      إجراءات <ChevronDown aria-hidden='true' />
    </DropdownMenuTrigger>
    <DropdownMenuContent align='end' className='w-52 max-w-[calc(100vw-2rem)]' dir='rtl'>
      <DropdownMenuGroup>
        <DropdownMenuLabel className='truncate'>{student.name}</DropdownMenuLabel>
        <DropdownMenuItem render={<PrefetchLink href={profile} />}>عرض الملف</DropdownMenuItem>
        <DropdownMenuItem render={<PrefetchLink href={`${profile}/report`} />}>تقرير الطالب</DropdownMenuItem>
        {student.can_manage ? <DropdownMenuItem render={<PrefetchLink href={`${profile}/edit`} />}>تعديل البيانات</DropdownMenuItem> : null}
        <DropdownMenuItem render={<PrefetchLink href={`${profile}?tab=study`} />}>الدراسة</DropdownMenuItem>
        <DropdownMenuItem render={<PrefetchLink href={`${profile}?tab=attendance`} />}>الحضور والغياب</DropdownMenuItem>
        {canReadFinance ? <DropdownMenuItem render={<PrefetchLink href={`${profile}/account`} />}>الحساب المالي</DropdownMenuItem> : null}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem render={<a href={workspaceApiHref(`/api/v1/center/students/${student.id}/barcode`, workspaceId)} target='_blank' rel='noopener noreferrer' />}>
        طباعة الباركود
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
