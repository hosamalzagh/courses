"use client";

import { GrantAuditDetails } from "@/components/GrantAuditDetails";
import { StudentAuditDetails } from "@/components/StudentAuditDetails";
import { CenterShell } from "@/components/CenterShell";
import { DataTable } from "@/components/DataTable";
import type { AuditEntry, CenterContext } from "@/lib/server-context";

const eventNames: Record<string, string> = {
  "branch.created": "إنشاء فرع", "branch.updated": "تعديل فرع",
  "member.invited": "دعوة موظف", "member.status_changed": "تغيير حالة عضو",
  "member.grants_changed": "تغيير الأدوار والإسنادات", "invitation.accepted": "قبول دعوة",
  "member.branch_grants_changed": "تغيير أدوار الفرع",
  "member.branch_status_changed": "تغيير حالة موظف الفرع",
  "center.settings_updated": "تعديل إعدادات المركز",
  "student.created": "إنشاء ملف طالب", "student.updated": "تعديل ملف طالب",
};

export function AuditWorkspace({ context, initialEntries }: { context: CenterContext; initialEntries: AuditEntry[] }) {
  return <CenterShell context={context} title="سجل التدقيق" description="آخر 50 تغييرًا ضمن نطاق صلاحيتك. التوقيت بتوقيت القاهرة.">
    <main className="members-main">

      <DataTable id="audit" title="الأحداث" description="البحث والتصفية ضمن آخر 50 تغييرًا فقط." rows={initialEntries} rowKey={(entry) => entry.id}
        searchText={(entry) => `${eventNames[entry.event] ?? entry.event} ${entry.branch_id ?? ""} ${entry.actor_id ?? ""}`} emptyMessage="لا توجد أحداث بعد."
        filters={[{ value: "center", label: "المركز", matches: (entry) => entry.branch_id === null }, { value: "branch", label: "الفروع", matches: (entry) => entry.branch_id !== null }]}
        columns={[
          { key: "event", label: "التغيير", filterText: (entry) => eventNames[entry.event] ?? entry.event, render: (entry) => <h3>{eventNames[entry.event] ?? entry.event}</h3> },
          { key: "scope", label: "النطاق", filterText: (entry) => entry.branch_id ? `فرع رقم ${entry.branch_id}` : "المركز", render: (entry) => entry.branch_id ? `فرع رقم ${entry.branch_id}` : "المركز" },
          { key: "actor", label: "المنفّذ", filterText: (entry) => entry.actor_id === null ? "غير معروف" : `منفّذ رقم ${entry.actor_id}`, render: (entry) => entry.actor_id === null ? "غير معروف" : `منفّذ رقم ${entry.actor_id}` },
          { key: "roles", label: "القيم قبل وبعد", render: (entry) => <><GrantAuditDetails entry={entry} /><StudentAuditDetails entry={entry} /></> },
          { key: "time", label: "الوقت · القاهرة", filterText: (entry) => new Date(entry.created_at).toLocaleString("ar-EG", { timeZone: "Africa/Cairo" }), render: (entry) => <time className="muted" dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}</time> },
        ]}
      />
    </main>
  </CenterShell>;
}
