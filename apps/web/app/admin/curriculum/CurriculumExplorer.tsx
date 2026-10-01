"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/Button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { curriculumNodeKey, type CurriculumExplorerContext, type CurriculumNode } from "@/lib/curriculum-explorer";
import { cn } from "@/lib/utils";
import { CurriculumTree } from "./CurriculumTree";

const CurriculumPresentation = createContext<(() => void) | null>(null);
export function useCurriculumPresentation() { return useContext(CurriculumPresentation); }

export function CurriculumExplorer({ context, children, actions }: {
  context: CurriculumExplorerContext; children: ReactNode; actions?: (node: CurriculumNode) => ReactNode;
}) {
  const selected = context.tree.path.at(-1);
  const selectedKey = selected ? curriculumNodeKey(selected) : null;
  const [selection, setSelection] = useState(selectedKey);
  const [canResume, setCanResume] = useState(Boolean(selected));
  const [detailVisible, setDetailVisible] = useState(Boolean(selected));
  const tree = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const treePosition = useRef(0);
  const scrollKey = `courses-curriculum-mobile-scroll:${context.user.id}:${context.workspace?.id ?? "legacy"}`;
  useEffect(() => {
    try { treePosition.current = Number(sessionStorage.getItem(scrollKey) ?? "0") || 0; } catch { /* Optional scroll memory. */ }
    const remember = () => {
      if (detailVisible || !window.matchMedia("(max-width: 900px)").matches) return;
      treePosition.current = window.scrollY;
      try { sessionStorage.setItem(scrollKey, String(treePosition.current)); } catch { /* Optional scroll memory. */ }
    };
    window.addEventListener("scroll", remember, { passive: true });
    return () => window.removeEventListener("scroll", remember);
  }, [scrollKey, detailVisible]);
  if (selection !== selectedKey) { setSelection(selectedKey); setCanResume(Boolean(selectedKey)); setDetailVisible(Boolean(selectedKey)); }
  function showDetails() { setCanResume(true); setDetailVisible(true); }
  function select() {
    treePosition.current = window.scrollY;
    if (window.matchMedia("(max-width: 900px)").matches) {
      try { sessionStorage.setItem(scrollKey, String(treePosition.current)); } catch { /* Optional scroll memory. */ }
    }
    showDetails();
  }
  function back() {
    setDetailVisible(false);
    requestAnimationFrame(() => {
      window.scrollTo({ top: treePosition.current });
      const target = selectedKey ? tree.current?.querySelector<HTMLElement>(`[data-curriculum-select="${selectedKey}"]`) : null;
      target?.focus({ preventScroll: true });
    });
  }
  return <CurriculumPresentation.Provider value={showDetails}><div className="grid min-w-0 items-start gap-4 min-[901px]:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]" data-curriculum-explorer>
    <div ref={tree} className={cn("min-w-0", detailVisible && "hidden min-[901px]:block")}>
      <CurriculumTree tree={context.tree} workspaceId={context.workspace?.id ?? "legacy"} userId={context.user.id} onSelect={select} actions={actions} />
      {canResume && !detailVisible ? <Button className="mt-3 min-[901px]:hidden" onClick={() => { setDetailVisible(true); requestAnimationFrame(() => detail.current?.focus()); }}>العودة إلى تفاصيل {selected?.name ?? "الكورس الجديد"}</Button> : null}
    </div>
    <div ref={detail} tabIndex={-1} className={cn("flex min-w-0 flex-col gap-3", !detailVisible && "hidden min-[901px]:flex")} data-curriculum-details>
      <Button className="self-start min-[901px]:hidden" onClick={back}>العودة للشجرة</Button>
      {children || <Empty><EmptyHeader><EmptyTitle>اختر عنصرًا من الشجرة</EmptyTitle><EmptyDescription>يفتح السهم الأبناء، ويعرض الاسم تفاصيل العنصر.</EmptyDescription></EmptyHeader></Empty>}
    </div>
  </div></CurriculumPresentation.Provider>;
}
