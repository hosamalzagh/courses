import "server-only";
import { PrefetchLink } from "@/components/PrefetchLink";
import type { ReactNode } from "react";
import { ThemeToggle } from "./ThemeProvider";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <aside className="auth-intro">
        <PrefetchLink className="brand" href="/login"><span className="brand-mark" aria-hidden="true">C</span><span>Courses</span></PrefetchLink>
        <div>
          <h2>لكل فرع مساحته. ولكل دور حدوده.</h2>
          <p>إدارة المركز تبدأ من عضويتك وصلاحياتك الحالية، وتبقى بيانات كل مركز في نطاقه.</p>
        </div>
        <small>لوحة المركز · تشغيل محلي</small>
      </aside>
      <main className="auth-main"><div className="auth-card"><div className="theme-control"><ThemeToggle /></div>{children}</div></main>
    </div>
  );
}
