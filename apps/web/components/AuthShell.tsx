import type { ReactNode } from "react";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <aside className="auth-intro">
        <a className="brand" href="/login"><span className="brand-mark" aria-hidden="true">C</span><span>Courses</span></a>
        <div>
          <h2>لكل فرع مساحته. ولكل دور حدوده.</h2>
          <p>إدارة المركز تبدأ من عضويتك وصلاحياتك الحالية، وتبقى بيانات كل مركز في نطاقه.</p>
        </div>
        <small>لوحة المركز · تشغيل محلي</small>
      </aside>
      <main className="auth-main"><div className="auth-card">{children}</div></main>
    </div>
  );
}
