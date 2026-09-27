"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmationDialog } from "./ConfirmationDialog";

type HistoryTraversal = { from: number; to: number };
let historyGuard: ((event: PopStateEvent, traversal: HistoryTraversal) => void) | null = null;
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
    historyGuard?.(event, traversal);
  }, true);
}

export function NavigationHistoryTracker() {
  useEffect(() => { trackNavigationHistory(); }, []);
  return null;
}

export function UnsavedChangesGuard({ dirty, guardHistory = false }: { dirty: boolean; guardHistory?: boolean }) {
  const router = useRouter();
  const [destination, setDestination] = useState<string | null>(null);
  const leaving = useRef(false);
  const dirtyRef = useRef(dirty);
  const historyDelta = useRef<number | null>(null);

  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  useEffect(() => {
    if (!guardHistory) return;
    trackNavigationHistory();
    leaving.current = false;
    let restoring = false;
    function traverse(event: PopStateEvent, traversal: HistoryTraversal) {
      if (restoring) { event.stopImmediatePropagation(); restoring = false; return; }
      if (!dirtyRef.current || leaving.current) return;
      const delta = traversal.to - traversal.from;
      if (delta === 0) return;
      event.stopImmediatePropagation();
      historyDelta.current = delta;
      restoring = true;
      window.history.go(-delta);
      setDestination("history");
    }
    historyGuard = traverse;
    return () => { if (historyGuard === traverse) historyGuard = null; };
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

  return destination && dirty ? <ConfirmationDialog title="مغادرة دون حفظ" description="لديك بيانات لم تُحفظ. يمكنك إلغاء المغادرة ومتابعة تعديلها، أو مغادرة الصفحة دون حفظها." confirmLabel="مغادرة دون حفظ" onCancel={() => { historyDelta.current = null; setDestination(null); }} onConfirm={() => {
    leaving.current = true;
    setDestination(null);
    if (historyDelta.current !== null) { window.history.go(historyDelta.current); return; }
    const url = new URL(destination);
    if (url.origin === window.location.origin) router.push(url.pathname + url.search + url.hash);
    else window.location.assign(destination);
  }} /> : null;
}
