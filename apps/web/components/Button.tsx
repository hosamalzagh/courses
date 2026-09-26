"use client";

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement>; variant?: "primary" | "secondary" | "danger"; busy?: boolean; busyLabel?: string; children: ReactNode };

export function Button({ variant = "secondary", busy = false, busyLabel = "جارٍ الحفظ…", children, className = "", disabled, type = "button", ...props }: Props) {
  return <button {...props} type={type} disabled={disabled || busy} aria-busy={busy || undefined} className={`button button-${variant} ${className}`}>
    <span className="button-label" style={{ visibility: busy ? "hidden" : undefined }}>{children}</span>
    {busy ? <span className="button-busy">{busyLabel}</span> : null}
  </button>;
}
