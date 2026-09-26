"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

type Theme = "light" | "dark";
const ThemeContext = createContext<{ theme: Theme; toggle: () => void } | null>(null);

export function ThemeProvider({ initialTheme, children }: { initialTheme: Theme; children: ReactNode }) {
  const [theme, setTheme] = useState(initialTheme);
  function toggle() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    document.cookie = `courses_theme=${next}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  }
  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const context = useContext(ThemeContext);
  if (!context) return null;
  return <button type="button" className={`button button-secondary ${compact ? "sidebar-icon-button" : ""}`} title={context.theme === "light" ? "تفعيل الوضع الداكن" : "تفعيل الوضع الفاتح"} onClick={context.toggle} aria-label={context.theme === "light" ? "تفعيل الوضع الداكن" : "تفعيل الوضع الفاتح"}>
    <span aria-hidden="true">{context.theme === "light" ? "◐" : "☀"}</span>{!compact ? (context.theme === "light" ? "داكن" : "فاتح") : null}
  </button>;
}
