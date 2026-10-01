"use client";

import { useEffect, useRef, useState } from "react";
import { useWorkspaceRouter as useRouter } from "@/components/WorkspaceNavigation";
import { ConfirmationDialog } from "./ConfirmationDialog";

type HistoryTraversal = { from: number; to: number };
type HistoryGuard = (event: PopStateEvent, traversal: HistoryTraversal) => boolean;
const historyGuards = new Set<HistoryGuard>();
const resetLeavingGuards = new Set<() => void>();
let historyIndex: number | null = null;

function trackNavigationHistory() {
  if (historyIndex !== null) return;
  historyIndex = Number.isInteger(window.history.state?.coursesHistoryIndex) ? window.history.state.coursesHistoryIndex : 0;
  const originalPush = window.history.pushState.bind(window.history);
  const originalReplace = window.history.replaceState.bind(window.history);
  originalReplace({ ...window.history.state, coursesHistoryIndex: historyIndex }, "");
  window.history.pushState = (state, unused, url) => {
    historyIndex = (historyIndex ?? 0) + 1;
    originalPush({ ...state, coursesHistoryIndex: historyIndex }, unused, url);
  };
  window.history.replaceState = (state, unused, url) => {
    originalReplace({ ...state, coursesHistoryIndex: historyIndex }, unused, url);
  };
  window.addEventListener("popstate", (event) => {
    const next = event.state?.coursesHistoryIndex;
    if (!Number.isInteger(next)) return;
    const traversal = { from: historyIndex ?? next, to: next };
    historyIndex = next;
    for (const guard of [...historyGuards].reverse()) {
      if (guard(event, traversal)) break;
    }
  }, true);
}

export function NavigationHistoryTracker() {
  useEffect(() => { trackNavigationHistory(); }, []);
  return null;
}

export function UnsavedChangesGuard({ dirty, guardHistory = false, blockDiscard = false,
  blockDiscardTitle = "تحقق من اعتماد التسوية أولًا",
  blockDiscardDescription = "تعذر التأكد من اعتماد التسوية. عد إلى المحرر واستخدم التحقق من الاعتماد قبل مغادرة الصفحة.",
  onDiscard }: {
  dirty: boolean; guardHistory?: boolean; blockDiscard?: boolean;
  blockDiscardTitle?: string; blockDiscardDescription?: string; onDiscard?: () => void;
}) {
  const router = useRouter();
  const [destination, setDestination] = useState<string | null>(null);
  const leaving = useRef(false);
  const dirtyRef = useRef(dirty);
  const historyDelta = useRef<number | null>(null);

  useEffect(() => {
    const resetLeaving = () => { leaving.current = false; };
    resetLeavingGuards.add(resetLeaving);
    return () => { resetLeavingGuards.delete(resetLeaving); };
  }, []);

  function cancelNavigation() {
    historyDelta.current = null;
    setDestination(null);
    for (const resetLeaving of resetLeavingGuards) resetLeaving();
  }

  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  useEffect(() => {
    if (!guardHistory) return;
    trackNavigationHistory();
    leaving.current = false;
    let restoring = false;
    function traverse(event: PopStateEvent, traversal: HistoryTraversal): boolean {
      if (restoring) { event.stopImmediatePropagation(); restoring = false; return true; }
      if (!dirtyRef.current || leaving.current) return false;
      const delta = traversal.to - traversal.from;
      if (delta === 0) return false;
      event.stopImmediatePropagation();
      historyDelta.current = delta;
      restoring = true;
      window.history.go(-delta);
      setDestination("history");
      return true;
    }
    historyGuards.add(traverse);
    return () => { historyGuards.delete(traverse); };
  }, [guardHistory]);

  useEffect(() => {
    if (!dirty) return;
    leaving.current = false;
    function beforeUnload(event: BeforeUnloadEvent) {
      if (leaving.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function followLink(event: MouseEvent) {
      if (leaving.current || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.download || (anchor.target && anchor.target !== "_self")) return;
      const url = new URL(anchor.href, window.location.href);
      if (!["http:", "https:"].includes(url.protocol) || url.href === window.location.href || (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search)) return;
      if (anchor.dataset.preserveDirtyNavigation === "true" && url.origin === location.origin && url.pathname === location.pathname) return;
      event.preventDefault();
      event.stopPropagation();
      historyDelta.current = null;
      setDestination(url.href);
    }
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", followLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", followLink, true);
    };
  }, [dirty]);

  if (destination && dirty && blockDiscard) return <ConfirmationDialog title={blockDiscardTitle}
    description={blockDiscardDescription}
    cancelLabel="العودة للتحقق" onCancel={cancelNavigation} />;

  return destination && dirty ? <ConfirmationDialog title="مغادرة دون حفظ" description="لديك بيانات لم تُحفظ. يمكنك إلغاء المغادرة ومتابعة تعديلها، أو مغادرة الصفحة دون حفظها." confirmLabel="مغادرة دون حفظ" onCancel={cancelNavigation} onConfirm={() => {
    leaving.current = true;
    onDiscard?.();
    setDestination(null);
    if (historyDelta.current !== null) { window.history.go(historyDelta.current); return; }
    const url = new URL(destination);
    if (url.origin === window.location.origin) router.push(url.pathname + url.search + url.hash);
    else window.location.assign(destination);
  }} /> : null;
}
