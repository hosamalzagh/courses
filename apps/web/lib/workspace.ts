export type CenterWorkspace = { id: string | null; mode: "branch" | "center"; branch: { id: number; name: string; slug: string; address: string | null } | null };

export function workspaceHref(href: string, id?: string | null): string {
  if (!id || !/^\/admin(?:[/?#]|$)/.test(href)) return href;
  const url = new URL(href, "http://courses.test");
  if (!url.searchParams.has("workspace")) url.searchParams.set("workspace", id);
  return url.pathname + url.search + url.hash;
}

export function workspaceSection(path: string): string {
  const section = path.match(/^\/admin\/(students|instructors|curriculum|equivalences|groups|absence-review|members|audit|settings)(?:\/|$)/)?.[1];
  return section ? `/admin/${section}` : "/admin";
}

/** Browser file navigation cannot send the workspace header. */
export function workspaceApiHref(href: string, id?: string | null): string {
  if (!id || !/^\/api\/v1\/center\//.test(href)) return href;
  const url = new URL(href, "http://courses.test");
  url.searchParams.set("workspace", id);
  return url.pathname + url.search + url.hash;
}
