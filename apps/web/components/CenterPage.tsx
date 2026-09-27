import "server-only";
import type { ReactNode } from "react";
import type { CenterContext } from "@/lib/server-context";
import { getAdminHeader } from "@/lib/admin-header";
import { CenterPageRegistration } from "./CenterShell";

// The page structure and metadata stay on the server. Only the controls passed
// as children and the small bridge to the persistent header need hydration.
export function CenterPage({ context, path, children, className = "" }: { context: CenterContext; path: string; children: ReactNode; className?: string }) {
  return <>
    <CenterPageRegistration context={context} {...getAdminHeader(path, context)} />
    <main className={`members-main ${className}`.trim()}>{children}</main>
  </>;
}
