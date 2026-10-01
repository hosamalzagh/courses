"use client";

import { PrefetchLink } from "@/components/PrefetchLink";
import type { CenterContext } from "@/lib/server-context";
import type { Course, Level, Stage } from "@/lib/curriculum";
import { Button } from "@/components/Button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ChevronDown, Settings2, Trash2 } from "lucide-react";
export type ManagedCurriculumRecord = { kind: "course"; record: Course } | { kind: "stage"; record: Stage } | { kind: "level"; record: Level };
export type CurriculumRecordAction = "stage" | "level" | "plan" | "new-version" | "threshold" | "copy" | "delete";
const labels = { course: "الكورس", stage: "المرحلة الدراسية", level: "المستوى" };

export function canCopyCurriculum(permissions: CenterContext["permissions"], sourceBranchId: number): boolean {
  return permissions.can_manage_center || Object.entries(permissions.branch_actions ?? {}).some(([branchId, actions]) => Number(branchId) !== sourceBranchId && actions.includes("curriculum.manage"));
}

export function CurriculumRecordMenu({ selection, triggerId, disabled, compact, canCopy, onAction, onOpenChange, finalFocus, actionHref }: {
  selection: ManagedCurriculumRecord; triggerId: string; disabled?: boolean; compact?: boolean; canCopy?: boolean;
  actionHref?: (action: CurriculumRecordAction) => string; onAction: (action: CurriculumRecordAction) => void; onOpenChange?: (open: boolean) => void; finalFocus?: () => boolean;
}) {
  const action = (key: CurriculumRecordAction) => actionHref ? { render: <PrefetchLink href={actionHref(key)} /> } : { onClick: () => onAction(key) };
  const reasonId = `${triggerId}-deletion-reason`;
  return <DropdownMenu onOpenChange={onOpenChange}>
    <DropdownMenuTrigger render={<Button size={compact ? "icon-sm" : "sm"} variant={compact ? "ghost" : "secondary"} />} id={triggerId} data-curriculum-edit={selection.record.id} disabled={disabled} aria-label={`إدارة ${labels[selection.kind]}: ${selection.record.name}`}><Settings2 data-icon="inline-start" />{!compact ? <>إدارة<ChevronDown data-icon="inline-end" /></> : null}</DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-2rem)]" dir="rtl" finalFocus={finalFocus}>
      <DropdownMenuGroup><DropdownMenuLabel className="break-words"><bdi>{selection.record.name}</bdi></DropdownMenuLabel>
        {selection.record.can_manage ? <>
          {selection.kind === "course" ? <DropdownMenuItem {...action("stage")}>إضافة مرحلة دراسية</DropdownMenuItem> : null}
          {selection.kind === "stage" ? <DropdownMenuItem {...action("level")}>إضافة مستوى وخطته</DropdownMenuItem> : null}
          {selection.kind === "level" ? <>{selection.record.latest_version === 1 && !selection.record.plan.used_at ? <DropdownMenuItem {...action("plan")}>تعديل الخطة الأولى</DropdownMenuItem> : null}<DropdownMenuItem {...action("new-version")}>إنشاء إصدار جديد</DropdownMenuItem></> : null}
          <DropdownMenuItem {...action("threshold")}>تحديد نسبة الإتمام</DropdownMenuItem>
        </> : null}
        {selection.kind === "course" && canCopy ? <DropdownMenuItem {...action("copy")}>نسخ المنهج إلى فرع</DropdownMenuItem> : null}
      </DropdownMenuGroup>
      {selection.record.can_manage ? <><DropdownMenuSeparator /><DropdownMenuGroup>
        <DropdownMenuItem variant="destructive" disabled={!selection.record.can_delete} aria-describedby={selection.record.deletion_blocked_reason ? reasonId : undefined} {...action("delete")}><Trash2 />حذف {labels[selection.kind]}</DropdownMenuItem>
        {selection.record.deletion_blocked_reason ? <DropdownMenuLabel id={reasonId} className="whitespace-normal">{selection.record.deletion_blocked_reason}</DropdownMenuLabel> : null}
      </DropdownMenuGroup></> : null}
    </DropdownMenuContent>
  </DropdownMenu>;
}
