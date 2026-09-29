import type { ReactNode } from "react";

export function SettingsRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return <div className="settings-row">
    <div className="settings-row-copy"><h2>{title}</h2><p>{description}</p></div>
    <div className="settings-row-control">{children}</div>
  </div>;
}
