"use client";

import { GrantAuditDetails } from "@/components/GrantAuditDetails";
import type { AuditEntry } from "@/lib/server-context";

const eventNames: Record<string, string> = {
  "branch.created": "إنشاء فرع", "branch.updated": "تعديل فرع",
  "member.invited": "دعوة موظف", "member.status_changed": "تغيير حالة عضو",
  "member.grants_changed": "تغيير الأدوار والإسنادات", "invitation.accepted": "قبول دعوة",
  "member.branch_grants_changed": "تغيير أدوار الفرع",
  "member.branch_status_changed": "تغيير حالة موظف الفرع",
  "center.settings_updated": "تعديل إعدادات المركز",
};

export function AuditWorkspace({ centerName, initialEntries }: { centerName: string; initialEntries: AuditEntry[] }) {

  return <div className="workspace">
    <header className="workspace-header"><div className="workspace-header-inner"><a className="brand" href="/admin"><span className="brand-mark">C</span>Courses</a><span className="muted">{centerName} · عضويتك نشطة</span><a className="text-link" href="/admin">العودة إلى الفروع</a></div></header>
    <main className="members-main"><div><span className="eyebrow">{centerName}</span><h1>سجل التدقيق</h1><p className="muted">آخر 50 تغييرًا ضمن نطاق صلاحيتك.</p></div>
      {initialEntries.length === 0 ? <div className="empty-state">لا توجد أحداث بعد.</div> : null}
      <div className="member-list">{initialEntries.map((entry) => <article className="member-card" key={entry.id}>
        <div className="member-card-head"><h3>{eventNames[entry.event] ?? entry.event}</h3><time className="muted" dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleString("ar-EG")}</time></div>
        <p className="muted">{entry.branch_id ? `فرع رقم ${entry.branch_id}` : "المركز"} · منفّذ رقم {entry.actor_id ?? "غير معروف"}</p>
        <GrantAuditDetails entry={entry} />
      </article>)}</div>
    </main>
  </div>;
}
