"use client";

import type { ComponentProps } from "react";
import { Button as ShadcnButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

type Props = Omit<ComponentProps<typeof ShadcnButton>, "variant"> & {
  variant?: "primary" | "secondary" | "danger" | "ghost" | "link";
  busy?: boolean;
  busyLabel?: string;
};

const variants = { primary: "default", secondary: "outline", danger: "destructive", ghost: "ghost", link: "link" } as const;

// Preserve the application's action API while using the official primitive.
export function Button({ variant = "secondary", busy = false, busyLabel = "جارٍ الحفظ…", children, className, disabled, type = "button", ...props }: Props) {
  return <ShadcnButton {...props} className={cn("relative", className)} variant={variants[variant]} type={type} disabled={disabled || busy} aria-busy={busy || undefined}>
    <span className={busy ? "invisible" : undefined} aria-hidden={busy || undefined}>{children}</span>
    {busy ? <span className="absolute inset-0 flex items-center justify-center gap-1.5"><Spinner data-icon="inline-start" />{busyLabel}</span> : null}
  </ShadcnButton>;
}
