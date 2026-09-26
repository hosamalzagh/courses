"use client";

import { createContext, useContext, useSyncExternalStore } from "react";

export const TablePreferenceUser = createContext("anonymous");
const changed = "courses-table-preferences-changed";
const fallback = new Map<string, string>();
function subscribe(callback: () => void) {
  window.addEventListener(changed, callback);
  return () => window.removeEventListener(changed, callback);
}

export function useTablePreferences(id: string, columns: { key: string; actions?: boolean }[]) {
  const user = useContext(TablePreferenceUser);
  const name = `courses_table_${encodeURIComponent(user)}_${encodeURIComponent(id)}`;
  const saved = useSyncExternalStore(subscribe, () => {
    const cookie = document.cookie.split("; ").find((part) => part.startsWith(`${name}=`));
    return cookie?.slice(name.length + 1) ?? fallback.get(`${location.host}:${name}`) ?? "";
  }, () => "");
  const movable = columns.filter((column) => !column.actions).map((column) => column.key);
  let order = movable;
  let hidden: string[] = [];
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(saved));
    if (parsed && typeof parsed === "object") {
      const data = parsed as { order?: unknown; hidden?: unknown };
      if (Array.isArray(data.order)) order = [...new Set([...data.order.filter((key): key is string => typeof key === "string" && movable.includes(key)), ...movable])];
      if (Array.isArray(data.hidden)) hidden = data.hidden.filter((key): key is string => typeof key === "string" && movable.includes(key) && key !== movable[0]);
    }
  } catch { /* Absent or invalid display preferences use the defaults. */ }
  const ordered = [...order, ...columns.filter((column) => column.actions).map((column) => column.key)];
  function save(nextOrder: string[], nextHidden: string[]) {
    const value = encodeURIComponent(JSON.stringify({ order: nextOrder, hidden: nextHidden }));
    fallback.set(`${location.host}:${name}`, value);
    document.cookie = `${name}=${value}; Path=/admin; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
    window.dispatchEvent(new Event(changed));
  }
  function move(source: string, target: string) {
    const from = order.indexOf(source), to = order.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...order];
    next.splice(from, 1); next.splice(to, 0, source);
    save(next, hidden);
  }
  return { ordered, movable: order, hidden, move,
    toggle: (key: string) => { if (movable.includes(key) && key !== movable[0]) save(order, hidden.includes(key) ? hidden.filter((item) => item !== key) : [...hidden, key]); },
    reset: () => save(movable, []),
  };
}
