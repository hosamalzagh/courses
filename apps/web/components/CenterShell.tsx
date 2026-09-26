"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { CenterContext } from "@/lib/server-context";
import { centerRequest, responseMessage } from "@/lib/client-api";
import { Button } from "./Button";
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

export function CenterShell({ context, children, title, description, actions }: { context: CenterContext; children: ReactNode; title: string; description?: ReactNode; actions?: ReactNode }) {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const drawer = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const canAudit = context.permissions.can_manage_center || Object.values(context.permissions.branch_roles).some((roles) => roles.includes("branch_auditor"));
  const links = [
    { href: "/admin", label: "الفروع", icon: "branches", visible: true },
    { href: "/admin/students", label: "الطلاب", icon: "members", visible: context.permissions.can_manage_center || Object.values(context.permissions.branch_actions ?? {}).some((actions) => actions.includes("read")) },
    { href: "/admin/members", label: "إدارة الموظفين والدعوات", icon: "members", visible: context.permissions.can_manage_center },
    { href: "/admin/audit", label: "سجل التدقيق", icon: "audit", visible: canAudit },
    { href: "/admin/settings", label: "إعدادات المركز", icon: "settings", visible: context.permissions.can_manage_center },
    { href: "/admin/security", label: "أمان الحساب", icon: "security", visible: true },
  ].filter((link) => link.visible);

  useEffect(() => {
    if (!menuOpen) return;
    const element = drawer.current;
    const trigger = menuButton.current;
    element?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // A drawer becomes desktop navigation when the viewport widens.
    const media = matchMedia("(min-width: 901px)");
    const closeOnDesktop = () => { if (media.matches) setMenuOpen(false); };
    media.addEventListener("change", closeOnDesktop);
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      media.removeEventListener("change", closeOnDesktop);
      trigger?.focus();
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
    return <nav aria-label={mobile ? "تنقل المركز على الهاتف" : "إدارة المركز"} className="center-nav">{links.filter((link) => footer === ["settings", "security"].includes(link.icon)).map((link) => <a key={link.href} href={link.href} aria-current={path === link.href ? "page" : undefined} title={collapsed && !mobile ? link.label : undefined} onClick={() => setMenuOpen(false)}>
      <svg className="nav-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">{navigationIcons[link.icon]}</svg><span className={collapsed && !mobile ? "sr-only" : ""}>{link.label}</span>
    </a>)}</nav>;
  }

  function account(mobile = false) {
    return <div className="sidebar-account">
      {!collapsed || mobile ? <div className="sidebar-user"><strong>{context.user.name}</strong><span className="membership-status"><span aria-hidden="true">●</span> نشطة</span></div> : null}
      <div className="sidebar-account-actions">
        {!mobile ? <Button className="sidebar-icon-button" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-label={collapsed ? "توسيع القائمة الجانبية" : "طي القائمة الجانبية"} title={collapsed ? "توسيع القائمة" : "طي القائمة"}><span aria-hidden="true">{collapsed ? "‹" : "›"}</span></Button> : null}
        <ThemeToggle compact />
        <Button className="sidebar-icon-button" onClick={signOut} busy={busy} busyLabel="…" aria-label="تسجيل الخروج" title="تسجيل الخروج"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M10 4H4v16h6M14 8l4 4-4 4M8 12h10" /></svg></Button>
      </div>
    </div>;
  }

  return <TablePreferenceUser.Provider value={String(context.user.id)}><div className={`center-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
    <a className="skip-link" href="#center-content">انتقل إلى المحتوى</a>
    <aside className="center-sidebar">
      <a className="brand" href="/admin" aria-label="Courses — الفروع"><span className="brand-mark" aria-hidden="true">C</span>{!collapsed ? <span>Courses</span> : null}</a>
      {!collapsed ? <div className="sidebar-center"><span className="eyebrow">مساحة المركز</span><strong>{context.center.name}</strong></div> : null}
      <div className="sidebar-navigation">{navigation()}</div>
      <div className="sidebar-bottom">{navigation(false, true)}
        {account()}
      </div>
    </aside>
    <div className="center-frame">
      <header className="center-topbar">
        <div className="topbar-context"><button ref={menuButton} className="button button-secondary mobile-menu-button" type="button" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>القائمة</button><div><nav className="page-breadcrumbs" aria-label="مسار الصفحة"><a href="/admin">{context.center.name}</a><span aria-hidden="true">‹</span><span aria-current="page">{title}</span></nav><h1>{title}</h1>{description ? <p className="page-description">{description}</p> : null}</div></div>
        {actions ? <div className="topbar-actions">{actions}</div> : null}
      </header>
      <div id="center-content" tabIndex={-1} className="center-content">{error ? <InlineNotice tone="error">{error}</InlineNotice> : null}{children}</div>
      <footer className="center-footer">Courses <span>·</span> إدارة المركز والفروع</footer>
    </div>
    {menuOpen ? <dialog ref={drawer} className="navigation-drawer" aria-labelledby="drawer-title" onCancel={() => setMenuOpen(false)}>
      <div className="drawer-heading"><h2 id="drawer-title">{context.center.name}</h2><Button onClick={() => setMenuOpen(false)}>إغلاق القائمة</Button></div><div className="sidebar-navigation">{navigation(true)}</div><div className="sidebar-bottom">{navigation(true, true)}{account(true)}</div>
    </dialog> : null}
  </div></TablePreferenceUser.Provider>;
}
