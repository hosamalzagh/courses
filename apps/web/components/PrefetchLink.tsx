"use client";

import Link from "next/link";
import { useState, type ComponentProps } from "react";

// Full SSR payloads are warmed on intent, rather than loading every private
// workspace just because its link is visible in the sidebar or a table.
export function PrefetchLink({ onMouseEnter, onMouseLeave, onFocus, onBlur, onPointerDown, ...props }: Omit<ComponentProps<typeof Link>, "prefetch">) {
  const [intent, setIntent] = useState(false);
  return <Link {...props} prefetch={intent}
    onMouseEnter={(event) => { setIntent(true); onMouseEnter?.(event); }}
    onMouseLeave={(event) => { setIntent(event.currentTarget.matches(":focus")); onMouseLeave?.(event); }}
    onFocus={(event) => { setIntent(true); onFocus?.(event); }}
    onBlur={(event) => { setIntent(event.currentTarget.matches(":hover")); onBlur?.(event); }}
    onPointerDown={(event) => { setIntent(true); onPointerDown?.(event); }}
  />;
}
