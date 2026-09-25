import type { ReactNode } from "react";

type Props = { children: ReactNode; tone?: "info" | "error" | "warning" };

export function InlineNotice({ children, tone = "info" }: Props) {
  return <div role={tone === "error" ? "alert" : "status"} className={`notice ${tone === "info" ? "" : `notice-${tone}`}`}>{children}</div>;
}
