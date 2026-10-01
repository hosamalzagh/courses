import "server-only";
import { WorkspaceContent } from "./WorkspaceNavigation";
import type { ReactNode } from "react";
import type { CenterContext } from "@/lib/server-context";
import { getAdminHeader } from "@/lib/admin-header";
import { CenterPageRegistration, type PageTrail } from "./CenterShell";

// The page structure and metadata stay on the server. Only the controls passed
// as children and the small bridge to the persistent header need hydration.
export function CenterPage({ context, path, children, className = "", title, trail }: { context: CenterContext; path: string; children: ReactNode; className?: string; title?: string; trail?: PageTrail }) {
  return <WorkspaceContent key={context.workspace?.id ?? "center"} id={context.workspace?.id ?? null}>
    <CenterPageRegistration context={context} {...getAdminHeader(path, context)} {...(title ? { title } : {})} trail={trail} />
    <main className={`members-main ${className}`.trim()}>{children}</main>
  </WorkspaceContent>;
}
