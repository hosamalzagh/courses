'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { PrefetchLink as Link } from '@/components/PrefetchLink';

import { buttonVariants } from "@/components/ui/button";

// Mounted inside the shared header, after its page actions have registered.
export function StudentNavigationLink({ href, focusKey, children, primary = false }: { href: string; focusKey: string; children: ReactNode; primary?: boolean }) {
  const link = useRef<HTMLAnchorElement>(null);
  const params = useSearchParams();
  const [recoveringFocus, setRecoveringFocus] = useState(params.get('focus') === focusKey);
  useEffect(() => {
    if (params.get('focus') !== focusKey) return;
    const frame = requestAnimationFrame(() => { link.current?.focus(); setRecoveringFocus(false); });
    return () => cancelAnimationFrame(frame);
  }, [params, focusKey]);
  return <Link className={buttonVariants({ variant: primary ? 'default' : 'outline' })} prefetchOnFocus={!recoveringFocus} ref={link} href={href}>{children}</Link>;
}
