"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useMemo, useId, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { useLinkStatus } from "next/link";
import { PrefetchLink as Link } from "./PrefetchLink";
import { getAdminHeader } from "@/lib/admin-header";
import { usePathname } from "next/navigation";
import type { CenterContext } from "@/lib/server-context";
import { centerRequest, responseMessage } from "@/lib/client-api";
import { Button } from "./Button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetClose, SheetTrigger } from "./ui/sheet";
import { ThemeToggle } from "./ThemeProvider";
import { InlineNotice } from "./InlineNotice";
import { TablePreferenceUser } from "./TablePreferences";

const navigationIcons: Record<string, ReactNode> = {
  branches: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  members: <><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5" /></>,
  audit: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" /></>,
  settings: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="8" cy="18" r="2" /></>,
  security: <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" /><path d="m8 12 3 3 5-6" /></>,
};

type PageHeader = { context: CenterContext; title: string; description?: ReactNode; path: string };
type PageActions = { context?: CenterContext; actions?: ReactNode; path: string };
const PageRegistration = createContext<{ register: Dispatch<SetStateAction<PageHeader | null>>; registerActions: Dispatch<SetStateAction<Record<string, PageActions>>> } | null>(null);

function NavigationPending() {
  const { pending } = useLinkStatus();
  return pending ? <span className="route-progress" role="status"><span className="sr-only">جارٍ تحميل محتوى الصفحة…</span></span> : null;
}

// Tiny client bridges keep server page markup outside the client module tree.
export function CenterPageRegistration({ context, title, description }: { context: CenterContext; title: string; description?: ReactNode }) {
  const register = useContext(PageRegistration)?.register;
  const path = usePathname();
  useLayoutEffect(() => {
    if (!register) return;
    const page = { context, title, description, path };
    register(page);
    return () => register((current) => current === page ? null : current);
  }, [register, context, title, description, path]);
  return null;
}

export function CenterPageActions({ context, actions }: { context?: CenterContext; actions?: ReactNode }) {
  const register = useContext(PageRegistration)?.registerActions;
  const path = usePathname();
  const id = useId();
  useLayoutEffect(() => {
    if (!register) return;
    const page = { context, actions, path };
    register((current) => ({ ...current, [id]: page }));
    return () => register((current) => {
      if (current[id] !== page) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, [register, context, actions, path, id]);
  return null;
}

// Every editor contributes its actions to the persistent page header.
// Submit buttons retain their explicit native `form` association.
export function CenterHeaderActions({ children }: { children: ReactNode }) {
  return <CenterPageActions actions={children} />;
}

export function CenterLayout({ initialContext, children }: { initialContext: CenterContext; children: ReactNode }) {
  const path = usePathname();
  const [page, register] = useState<PageHeader | null>(null);
  const [pageActions, registerActions] = useState<Record<string, PageActions>>({});
  const registration = useMemo(() => ({ register, registerActions }), []);
  const currentActions = Object.entries(pageActions).filter(([, item]) => item.path === path).sort(([a, left], [b, right]) => Number(!left.context) - Number(!right.context) || a.localeCompare(b));
  const context = currentActions.find(([, item]) => item.context)?.[1].context ?? (page?.path === path ? page.context : initialContext);
  const currentPage = page?.path === path ? page : null;
  const fallbackHeader = getAdminHeader(path, context);
  const title = currentPage?.title ?? fallbackHeader.title;
  const description = currentPage?.description ?? fallbackHeader.description;
  const actions = currentActions.map(([id, item]) => <span key={id} className="header-action-group">{item.actions}</span>);
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const drawerClose = useRef<HTMLButtonElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const canAudit = context.permissions.can_manage_center || Object.values(context.permissions.branch_roles).some((roles) => roles.includes("branch_auditor"));
  const links = [
    { href: "/admin", label: "الفروع", icon: "branches", visible: true },
    { href: "/admin/students", label: "الطلاب", icon: "members", visible: context.permissions.can_manage_center || Object.values(context.permissions.branch_actions ?? {}).some((actions) => actions.includes("read")) },
    { href: "/admin/student-search", label: "البحث في طلاب المركز", icon: "members", visible: context.permissions.can_manage_center || Object.values(context.permissions.branch_actions ?? {}).some((actions) => actions.includes("students.search_center")) },
    { href: "/admin/instructors", label: "المحاضرون", icon: "members", visible: context.permissions.can_manage_center || Object.values(context.permissions.branch_actions ?? {}).some((actions) => actions.includes("read")) },
    { href: "/admin/curriculum", label: "المناهج والخطط", icon: "audit", visible: context.permissions.can_manage_center || Object.values(context.permissions.branch_actions ?? {}).some((actions) => actions.includes("read")) },
    { href: "/admin/groups", label: "المجموعات الدراسية", icon: "audit", visible: context.permissions.can_manage_center || Object.values(context.permissions.branch_actions ?? {}).some((actions) => actions.includes("read")) },
    { href: "/admin/members", label: "إدارة الموظفين والدعوات", icon: "members", visible: context.permissions.can_manage_center },
    { href: "/admin/audit", label: "سجل التدقيق", icon: "audit", visible: canAudit },
    { href: "/admin/student-custom-fields", label: "الحقول الإضافية للطالب", icon: "settings", visible: context.permissions.can_manage_center },
    { href: "/admin/student-profile-choices", label: "قوائم بيانات الطالب", icon: "settings", visible: context.permissions.can_manage_center },
    { href: "/admin/settings", label: "إعدادات المركز", icon: "settings", visible: context.permissions.can_manage_center },
    { href: "/admin/security", label: "أمان الحساب", icon: "security", visible: true },
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
    return <nav aria-label={mobile ? "تنقل المركز على الهاتف" : "إدارة المركز"} className="center-nav">{links.filter((link) => footer === ["settings", "security"].includes(link.icon)).map((link) => <Link key={link.href} href={link.href} aria-current={path === link.href ? "page" : undefined} title={collapsed && !mobile ? link.label : undefined} onClick={() => setMenuOpen(false)}>
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

  return <PageRegistration.Provider value={registration}><TablePreferenceUser.Provider value={String(context.user.id)}><Sheet open={menuOpen} onOpenChange={setMenuOpen}><div className={`center-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
    <a className="skip-link" href="#center-content">انتقل إلى المحتوى</a>
    <aside className="center-sidebar">
      <Link className="brand" href="/admin" aria-label="Courses — الفروع"><span className="brand-mark" aria-hidden="true">C</span>{!collapsed ? <span>Courses</span> : null}</Link>
      {!collapsed ? <div className="sidebar-center"><span className="eyebrow">مساحة المركز</span><strong>{context.center.name}</strong></div> : null}
      <div className="sidebar-navigation">{navigation()}</div>
      <div className="sidebar-bottom">{navigation(false, true)}
        {account()}
      </div>
    </aside>
    <div className="center-frame">
      <header className="center-topbar">
        <div className="topbar-context"><SheetTrigger render={<Button ref={menuButton} className="hidden min-w-0 max-[900px]:inline-flex" />}>القائمة</SheetTrigger><div><nav className="page-breadcrumbs" aria-label="مسار الصفحة"><Link href="/admin">{context.center.name}<NavigationPending /></Link><span aria-hidden="true">‹</span><span aria-current="page">{title}</span></nav><h1>{title}</h1>{description ? <p className="page-description">{description}</p> : null}</div></div>
        <div className="topbar-actions">{actions}</div>
      </header>
      <div id="center-content" tabIndex={-1} className="center-content">{error ? <InlineNotice tone="error">{error}</InlineNotice> : null}{children}</div>
      <footer className="center-footer">Courses <span>·</span> إدارة المركز والفروع</footer>
    </div>
    <SheetContent side="right" showCloseButton={false} initialFocus={drawerClose} finalFocus={menuButton} className="p-4">
      <SheetHeader><div className="flex items-center justify-between gap-2"><SheetTitle>{context.center.name}</SheetTitle><SheetClose ref={drawerClose} render={<Button />}>إغلاق القائمة</SheetClose></div></SheetHeader>
      <div className="sidebar-navigation">{navigation(true)}</div><div className="sidebar-bottom">{navigation(true, true)}{account(true)}</div>
    </SheetContent>
  </div></Sheet></TablePreferenceUser.Provider></PageRegistration.Provider>;
}
