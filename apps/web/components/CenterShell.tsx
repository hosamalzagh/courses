"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useMemo, useId, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { useLinkStatus } from "next/link";
import { PrefetchLink as Link } from "./PrefetchLink";
import { getAdminHeader } from "@/lib/admin-header";
import { WorkspaceNavigation, useWorkspaceId } from "./WorkspaceNavigation";
import { workspaceSection } from "@/lib/workspace";
import { usePathname, useSearchParams } from "next/navigation";
import type { CenterContext } from "@/lib/server-context";
import { centerRequest, responseMessage } from "@/lib/client-api";
import { Button } from "./Button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetClose, SheetTrigger } from "./ui/sheet";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "./ui/dropdown-menu";
import { ThemeToggle } from "./ThemeProvider";
import { InlineNotice } from "./InlineNotice";
import { TablePreferenceUser } from "./TablePreferences";
import { canReadStudents, canSearchCenterStudents } from "@/lib/student-search-access";

const navigationIcons: Record<string, ReactNode> = {
  branches: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  members: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5" /></>,
  audit: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></>,
  settings: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="8" cy="18" r="2" /></>,
  security: <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" /><path d="m8 12 3 3 5-6" /></>,
};

export type PageTrail = { label: string; href: string; preserveSearchParams?: readonly string[] }[];
type PageHeader = { context: CenterContext; title: string; description?: ReactNode; path: string; workspace: string | null; trail?: PageTrail };
type PageActions = { context?: CenterContext; actions?: ReactNode; path: string; workspace: string | null };
const PageRegistration = createContext<{ register: Dispatch<SetStateAction<PageHeader | null>>; registerActions: Dispatch<SetStateAction<Record<string, PageActions>>> } | null>(null);

function NavigationPending() {
  const { pending } = useLinkStatus();
  return pending ? <span className="route-progress" role="status"><span className="sr-only">جارٍ تحميل محتوى الصفحة…</span></span> : null;
}

// Tiny client bridges keep server page markup outside the client module tree.
export function CenterPageRegistration({ context, title, description, trail }: { context: CenterContext; title: string; description?: ReactNode; trail?: PageTrail }) {
  const register = useContext(PageRegistration)?.register;
  const path = usePathname();
  const workspace = context.workspace?.id ?? null;
  useLayoutEffect(() => {
    if (!register) return;
    const page = { context, title, description, path, workspace, trail };
    register(page);
    return () => register((current) => current === page ? null : current);
  }, [register, context, title, description, path, workspace, trail]);
  return null;
}

export function CenterPageActions({ context, actions }: { context?: CenterContext; actions?: ReactNode }) {
  const register = useContext(PageRegistration)?.registerActions;
  const path = usePathname();
  const workspace = useWorkspaceId();
  const id = useId();
  useLayoutEffect(() => {
    if (!register) return;
    const page = { context, actions, path, workspace };
    register((current) => ({ ...current, [id]: page }));
    return () => register((current) => {
      if (current[id] !== page) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, [register, context, actions, path, workspace, id]);
  return null;
}

// Every editor contributes its actions to the persistent page header.
// Submit buttons retain their explicit native `form` association.
export function CenterHeaderActions({ children }: { children: ReactNode }) {
  return <CenterPageActions actions={children} />;
}

export function CenterLayout({ initialContext, children }: { initialContext: CenterContext; children: ReactNode }) {
  const path = usePathname();
  const searchParams = useSearchParams();
  const workspace = searchParams.get("workspace") ?? initialContext.workspace?.id ?? null;
  const [page, register] = useState<PageHeader | null>(null);
  const [pageActions, registerActions] = useState<Record<string, PageActions>>({});
  const registration = useMemo(() => ({ register, registerActions }), []);
  const currentActions = Object.entries(pageActions).filter(([, item]) => item.path === path && (path === "/admin/workspaces" || item.workspace === workspace)).sort(([a, left], [b, right]) => Number(!left.context) - Number(!right.context) || a.localeCompare(b));
  const context = currentActions.find(([, item]) => item.context)?.[1].context ?? (page?.path === path && (path === "/admin/workspaces" || page.workspace === workspace) ? page.context : initialContext);
  const workspaceResolved = !workspace || context.workspace?.id === workspace || path === "/admin/workspaces";
  const currentPage = page?.path === path && (path === "/admin/workspaces" || page.workspace === workspace) ? page : null;
  const fallbackHeader = getAdminHeader(path, context);
  const title = currentPage?.title ?? fallbackHeader.title;
  const description = currentPage?.description ?? fallbackHeader.description;
  function breadcrumbHref(item: PageTrail[number]) {
    if (!item.preserveSearchParams) return item.href;
    const target = new URL(item.href, "https://courses.invalid");
    for (const key of item.preserveSearchParams) {
      const value = searchParams.get(key);
      if (value === null) target.searchParams.delete(key); else target.searchParams.set(key, value);
    }
    return target.pathname + target.search + target.hash;
  }
  const actions = currentActions.map(([id, item]) => <span key={id} className="header-action-group">{item.actions}</span>);
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const drawerClose = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const canAudit = context.permissions.can_manage_center || Object.values(context.permissions.branch_roles).some((roles) => roles.includes("branch_auditor"));
  const links = [
    { href: "/admin", label: "الرئيسية", icon: "branches", visible: true },
    { href: canReadStudents(context) ? "/admin/students" : "/admin/students?scope=center", label: "الطلاب", icon: "members", visible: canReadStudents(context) || canSearchCenterStudents(context) },
    { href: "/admin/instructors", label: "المحاضرون", icon: "members", visible: context.permissions.can_manage_center || Object.values(context.permissions.branch_actions ?? {}).some((actions) => actions.includes("read")) },
    { href: "/admin/curriculum", label: "المناهج والخطط", icon: "audit", visible: context.permissions.can_manage_center || Object.values(context.permissions.branch_actions ?? {}).some((actions) => actions.includes("read")) },
    { href: "/admin/equivalences", label: "معادلة المحتوى", icon: "audit", visible: context.permissions.can_manage_center || Object.values(context.permissions.branch_actions ?? {}).some((actions) => actions.includes("read")) },
    { href: "/admin/groups", label: "المجموعات الدراسية", icon: "audit", visible: context.permissions.can_manage_center || Object.values(context.permissions.branch_actions ?? {}).some((actions) => actions.includes("read")) },
    { href: "/admin/absence-review", label: "مراجعة الغياب", icon: "audit", visible: context.permissions.can_manage_center || Object.values(context.permissions.branch_actions ?? {}).some((actions) => actions.includes("read")) },
    { href: "/admin/members", label: "إدارة الموظفين والدعوات", icon: "members", visible: context.permissions.can_manage_center },
    { href: "/admin/audit", label: "سجل التدقيق", icon: "audit", visible: canAudit },
    { href: "/admin/settings", label: "الإعدادات", icon: "settings", visible: true },
  ].filter((link) => link.visible);

  useEffect(() => {
    if (!menuOpen) return;
    // A drawer becomes desktop navigation when the viewport widens.
    const media = matchMedia("(min-width: 901px)");
    const closeOnDesktop = () => { if (media.matches) setMenuOpen(false); };
    media.addEventListener("change", closeOnDesktop);
    return () => {
      media.removeEventListener("change", closeOnDesktop);

    };
  }, [menuOpen]);

  async function signOut() {
    setBusy(true); setError("");
    try {
      const response = await centerRequest("auth/logout", "POST");
      if (!response.ok) { setError(await responseMessage(response)); return; }
      window.location.replace("/login");
    } catch { setError("تعذر تسجيل الخروج. حاول مرة أخرى."); }
    finally { setBusy(false); }
  }

  function navigation(mobile = false, footer = false) {
    return <nav aria-label={mobile ? "تنقل المركز على الهاتف" : "إدارة المركز"} className="center-nav">{links.filter((link) => footer === ["settings", "security"].includes(link.icon)).map((link) => <Link key={link.href} href={link.href} aria-current={path === link.href.split("?")[0] ? "page" : undefined} title={collapsed && !mobile ? link.label : undefined} onClick={() => setMenuOpen(false)}>
      <svg className="nav-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{navigationIcons[link.icon]}</svg><span className={collapsed && !mobile ? "sr-only" : ""}>{link.label}</span><NavigationPending />
    </Link>)}</nav>;
  }

  function account(mobile = false) {
    return <div className="sidebar-account">
      {!collapsed || mobile ? <div className="sidebar-user"><strong>{context.user.name}</strong><span className="membership-status"><span aria-hidden="true">●</span> نشطة</span></div> : null}
      <div className="sidebar-account-actions">
        {!mobile ? <Button variant="ghost" size="icon" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed ? "توسيع القائمة الجانبية" : "طي القائمة الجانبية"} title={collapsed ? "توسيع القائمة" : "طي القائمة"}><span aria-hidden="true">{collapsed ? "‹" : "›"}</span></Button> : null}
        <ThemeToggle compact />
        <Button variant="ghost" size="icon" onClick={signOut} busy={busy} busyLabel="…" aria-label="تسجيل الخروج" title="تسجيل الخروج"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M10 4H4v16h6M14 8l4 4-4 4M8 12h10" /></svg></Button>
      </div>
    </div>;
  }

  return <WorkspaceNavigation.Provider value={workspace ?? context.workspace?.id ?? null}><PageRegistration.Provider value={registration}><TablePreferenceUser.Provider value={String(context.user.id)}><Sheet open={menuOpen} onOpenChange={setMenuOpen}><div className={`center-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
    <a className="skip-link" href="#center-content">انتقل إلى المحتوى</a>
    <aside className="center-sidebar">
      <Link className="brand" href="/admin" aria-label="Courses — الرئيسية"><span className="brand-mark" aria-hidden="true">C</span>{!collapsed ? <span>Courses</span> : null}</Link>
      {!collapsed ? <div className="sidebar-center"><span className="eyebrow">مساحة المركز</span><strong>{context.center.name}</strong></div> : null}
      <div className="sidebar-navigation">{navigation()}</div>
      <div className="sidebar-bottom">{navigation(false, true)}
        {account()}
      </div>
    </aside>
    <div className="center-frame">
      <header className="center-topbar">
        <div className="topbar-context"><SheetTrigger render={<Button ref={menuButton} className="hidden min-w-0 max-[900px]:inline-flex" />}>القائمة</SheetTrigger><div><nav className="page-breadcrumbs" aria-label="مسار الصفحة"><ol className="flex flex-wrap items-center gap-1"><li><Link href="/admin">{context.center.name}<NavigationPending /></Link></li>{(currentPage?.trail?.length ?? 0) > 1 ? <li className="min-[901px]:hidden"><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="sm" aria-label="عرض المسار الكامل" />}>…</DropdownMenuTrigger><DropdownMenuContent className="max-w-[calc(100vw-2rem)] w-64">{currentPage?.trail?.slice(0, -1).map(item => <DropdownMenuItem key={item.href} render={<Link href={breadcrumbHref(item)} />} className="whitespace-normal break-words">{item.label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></li> : null}{currentPage?.trail?.map((item, index) => <li key={item.href} className={`${index < (currentPage?.trail?.length ?? 0) - 1 ? "hidden min-[901px]:flex" : "flex"} min-w-0 items-center gap-1`}><span aria-hidden="true">‹</span><Link className="break-words" href={breadcrumbHref(item)}>{item.label}</Link></li>)}<li className="flex min-w-0 items-center gap-1"><span aria-hidden="true">‹</span><span aria-current="page">{title}</span></li></ol></nav><h1>{title}</h1><div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm"><span className="break-words" data-workspace-name>{!workspaceResolved ? "جارٍ تحميل مساحة العمل…" : context.workspace?.mode === "branch" ? context.workspace.branch?.name : context.workspace?.mode === "center" ? "إدارة المركز" : "اختر مساحة العمل"}</span>{path !== "/admin/workspaces" && context.workspace_can_switch ? <Link className="text-link" href={`/admin/workspaces?return_to=${encodeURIComponent(workspaceSection(path))}`}>تبديل مساحة العمل</Link> : null}{context.workspace?.mode === "branch" && (context.workspace_scope === "authorized_branches" || context.workspace_scope === "authorized_financial_branches" || context.workspace_scope === "center") && path !== "/admin/workspaces" ? <span className="muted">{context.workspace_scope === "authorized_financial_branches" ? "نطاق الحساب: الفروع المصرح بها ماليًا" : context.workspace_scope === "center" ? "نطاق الصفحة: المركز" : "نطاق الصفحة: الفروع المصرح بها"}</span> : null}</div>{description ? <p className="page-description">{description}</p> : null}</div></div>
        <div className="topbar-actions">{actions}</div>
      </header>
      <div id="center-content" tabIndex={-1} className="center-content">{error ? <InlineNotice tone="error">{error}</InlineNotice> : null}{children}</div>
      <footer className="center-footer">Courses <span>·</span> إدارة المركز والفروع</footer>
    </div>
    <SheetContent side="right" showCloseButton={false} initialFocus={drawerClose} finalFocus={menuButton} className="p-4">
      <SheetHeader><div className="flex items-center justify-between gap-2"><SheetTitle>{context.center.name}</SheetTitle><SheetClose ref={drawerClose} render={<Button />}>إغلاق القائمة</SheetClose></div></SheetHeader>
      <div className="sidebar-navigation">{navigation(true)}</div><div className="sidebar-bottom">{navigation(true, true)}{account(true)}</div>
    </SheetContent>
  </div></Sheet></TablePreferenceUser.Provider></PageRegistration.Provider></WorkspaceNavigation.Provider>;
}
