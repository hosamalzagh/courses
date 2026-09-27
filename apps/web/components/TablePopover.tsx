"use client";

import { useState, type ReactNode } from "react";
import { Button } from "./Button";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "./ui/popover";

export function TablePopover({ id, label, scope, title, count = 0, onOpen, open: controlledOpen, onOpenChange, children }: {
  id: string; label: string; scope: string; title: string; count?: number;
  onOpen?: () => void; open?: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  function change(next: boolean) { setLocalOpen(next); onOpenChange?.(next); if (next) onOpen?.(); }
  return <Popover open={open} onOpenChange={change}>
    <PopoverTrigger id={`${id}-trigger`} render={<Button />} aria-label={`${label} — ${scope}`}>
      {label}{count ? ` (${count.toLocaleString("ar-EG")})` : ""}
    </PopoverTrigger>
    <PopoverContent id={id} align="end" className="max-h-[calc(100dvh-2rem)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto">
      <PopoverHeader><div className="flex items-center justify-between gap-2"><PopoverTitle>{title}</PopoverTitle><Button size="icon" variant="ghost" aria-label={`إغلاق ${title}`} onClick={() => change(false)}>×</Button></div></PopoverHeader>
      {children}
    </PopoverContent>
  </Popover>;
}
