"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ConfirmationDialog } from "./ConfirmationDialog";

export function UnsavedChangesGuard({ dirty }: { dirty: boolean }) {
  const router = useRouter();
  const [destination, setDestination] = useState<string | null>(null);
  const leaving = useRef(false);

  useEffect(() => {
    if (!dirty) return;
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
      setDestination(url.href);
    }
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", followLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", followLink, true);
    };
  }, [dirty]);

  return destination && dirty ? <ConfirmationDialog title="مغادرة دون حفظ" description="لديك بيانات لم تُحفظ. يمكنك إلغاء المغادرة ومتابعة تعديلها، أو مغادرة الصفحة دون حفظها." confirmLabel="مغادرة دون حفظ" onCancel={() => setDestination(null)} onConfirm={() => {
    leaving.current = true;
    const url = new URL(destination);
    if (url.origin === window.location.origin) router.push(url.pathname + url.search + url.hash);
    else window.location.assign(destination);
  }} /> : null;
}
