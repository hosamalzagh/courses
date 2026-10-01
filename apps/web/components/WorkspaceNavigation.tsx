"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { workspaceHref } from "@/lib/workspace";

export const WorkspaceNavigation = createContext<string | null>(null);
export function useWorkspaceId() {
  const selected = useContext(WorkspaceNavigation);
  const params = useSearchParams();
  return selected ?? params.get("workspace");
}

export function useWorkspaceRouter() {
  const router = useRouter();
  const params = useSearchParams();
  const fallback = useWorkspaceId();
  const id = fallback ?? params.get("workspace");
  return useMemo(() => ({ ...router,
    push: (href: string, options?: Parameters<typeof router.push>[1]) => router.push(workspaceHref(href, id), options),
    replace: (href: string, options?: Parameters<typeof router.replace>[1]) => router.replace(workspaceHref(href, id), options),
  }), [router, id]);
}

export function WorkspaceContent({ id, children }: { id: string | null; children: ReactNode }) {
  return <WorkspaceNavigation.Provider value={id}>{children}</WorkspaceNavigation.Provider>;
}
