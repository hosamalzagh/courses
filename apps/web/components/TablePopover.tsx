"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";

export function TablePopover({ id, label, scope, title, count = 0, onOpen, children }: { id: string; label: string; scope: string; title: string; count?: number; onOpen?: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    function position() {
      if (!panel.current || !trigger.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const bounds = panel.current.getBoundingClientRect();
      const available = window.innerHeight - 32;
      const height = Math.min(bounds.height, available);
      panel.current.style.left = `${Math.max(16, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 16))}px`;
      panel.current.style.top = `${Math.max(16, Math.min(anchor.bottom + 8, window.innerHeight - height - 16))}px`;
    }
    position();
    panel.current?.querySelector<HTMLElement>(".table-popover-body input:not(:disabled), .table-popover-body button:not(:disabled)")?.focus();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open]);
  function close() { panel.current?.hidePopover(); trigger.current?.focus(); }
  return <>
    <Button ref={trigger} id={`${id}-trigger`} popoverTarget={id} aria-haspopup="dialog" aria-expanded={open} aria-label={`${label} — ${scope}`} onClick={(event) => { event.preventDefault(); panel.current?.togglePopover(); }}>{label}{count ? ` (${count.toLocaleString("ar-EG")})` : ""}</Button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-labelledby={`${id}-heading`} className="table-popover" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); close(); } }} onToggle={(event) => {
      const next = event.currentTarget.matches(":popover-open");
      setOpen(next); if (next) onOpen?.();
    }}>
      <div className="popover-heading"><h3 id={`${id}-heading`}>{title}</h3><button className="popover-close" type="button" aria-label={`إغلاق ${title}`} onClick={close}>×</button></div>
      <div className="table-popover-body">{children}</div>
    </div>
  </>;
}
