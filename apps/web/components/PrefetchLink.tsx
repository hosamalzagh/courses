"use client";

import Link from "next/link";
import { useWorkspaceId } from "./WorkspaceNavigation";
import { workspaceHref } from "@/lib/workspace";
import { useState, type ComponentProps } from "react";

// Full SSR payloads are warmed on intent, rather than loading every private
// workspace just because its link is visible in the sidebar or a table.
export function PrefetchLink({ onMouseEnter, onMouseLeave, onFocus, onBlur, onPointerDown, prefetchOnFocus = true, ...props }: Omit<ComponentProps<typeof Link>, "prefetch"> & { prefetchOnFocus?: boolean }) {
  const [intent, setIntent] = useState(false);
  const id = useWorkspaceId();
  const href = typeof props.href === "string" ? workspaceHref(props.href, id) : { ...props.href, query: { ...(typeof props.href.query === "object" ? props.href.query : Object.fromEntries(new URLSearchParams(props.href.query ?? ""))), ...(id ? { workspace: id } : {}) } };
  return <Link {...props} href={href} prefetch={intent}
    onMouseEnter={(event) => { setIntent(true); onMouseEnter?.(event); }}
    onMouseLeave={(event) => { setIntent(event.currentTarget.matches(":focus")); onMouseLeave?.(event); }}
    onFocus={(event) => { if (prefetchOnFocus) setIntent(true); onFocus?.(event); }}
    onBlur={(event) => { setIntent(event.currentTarget.matches(":hover")); onBlur?.(event); }}
    onPointerDown={(event) => { setIntent(true); onPointerDown?.(event); }}
  />;
}
