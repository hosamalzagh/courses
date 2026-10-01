"use client";
import { useId } from "react";
import { ChevronDown, Settings2 } from "lucide-react";
import { Button } from "@/components/Button";
import { PrefetchLink } from "@/components/PrefetchLink";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import type { StudyGroup } from "@/lib/groups";

export function GroupRecordMenu({ group, sessionsHref, manageHref, disabled, compact, onManage }: {
  group: StudyGroup; sessionsHref: string; manageHref?: string; disabled?: boolean; compact?: boolean; onManage?: () => void;
}) {
  const id = useId();
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button size={compact ? "icon-sm" : "sm"} variant={compact ? "ghost" : "secondary"} />} id={id} data-group-edit={group.id} disabled={disabled} aria-label={`إدارة المجموعة: ${group.name}`}><Settings2 />{!compact ? <>إدارة<ChevronDown /></> : null}</DropdownMenuTrigger>
    <DropdownMenuContent align="end" dir="rtl" className="w-64 max-w-[calc(100vw-2rem)]">
      <DropdownMenuGroup><DropdownMenuLabel><bdi>{group.name}</bdi></DropdownMenuLabel>
        {group.can_manage ? <DropdownMenuItem render={manageHref ? <PrefetchLink href={manageHref} /> : undefined} onClick={manageHref ? undefined : onManage}>إعدادات المجموعة</DropdownMenuItem> : null}
        <DropdownMenuItem render={<PrefetchLink href={sessionsHref} />}>جدول المحاضرات</DropdownMenuItem>
        <DropdownMenuItem render={<PrefetchLink href={`/admin/groups/${group.id}/coverage`} />}>تقرير التغطية</DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
