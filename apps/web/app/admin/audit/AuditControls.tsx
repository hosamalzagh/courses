"use client";

import type { ReactNode } from "react";
import { DataTable } from "@/components/DataTable";

export type AuditRow = {
  id: number; event: string; scope: string; actor: string; time: string;
  createdAt: string; branch: boolean; search: string; details: ReactNode;
};

// Filtering and column preferences are interactive; labels and detail markup
// arrive from the server as serializable values and server-rendered children.
export function AuditControls({ rows }: { rows: AuditRow[] }) {
  return <DataTable id="audit" title="الأحداث" description="البحث والتصفية ضمن آخر 50 تغييرًا فقط." rows={rows} rowKey={(row) => row.id}
    searchText={(row) => row.search} emptyMessage="لا توجد أحداث بعد."
    filters={[{ value: "center", label: "المركز", matches: (row) => !row.branch }, { value: "branch", label: "الفروع", matches: (row) => row.branch }]}
    columns={[
      { key: "event", label: "التغيير", filterText: (row) => row.event, render: (row) => <h3>{row.event}</h3> },
      { key: "scope", label: "النطاق", filterText: (row) => row.scope, render: (row) => row.scope },
      { key: "actor", label: "المنفّذ", filterText: (row) => row.actor, render: (row) => row.actor },
      { key: "roles", label: "القيم قبل وبعد", render: (row) => row.details },
      { key: "time", label: "الوقت · القاهرة", filterText: (row) => row.time, render: (row) => <time className="muted" dateTime={row.createdAt}>{row.time}</time> },
    ]}
  />;
}
