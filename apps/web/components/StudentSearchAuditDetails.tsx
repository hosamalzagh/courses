import type { AuditEntry } from '@/lib/server-context';

export function StudentSearchAuditDetails({ entry }: { entry: AuditEntry }) {
  if (!['center.student_search_changed', 'center.student_sharing_default_changed'].includes(entry.event)) return null;
  let details = entry.details;
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch { return null; }
  }
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const data = details as { before?: { enabled?: unknown; default_sharing_enabled?: unknown }; after?: { enabled?: unknown; default_sharing_enabled?: unknown } };
  const status = (value: unknown) => value === true ? 'مفعّل' : value === false ? 'مغلق' : 'غير مسجل';
  if (entry.event === 'center.student_sharing_default_changed') return <details><summary>عرض تغيير افتراضي المشاركة</summary><p>قبل التغيير: {status(data.before?.default_sharing_enabled)}</p><p>بعد التغيير: {status(data.after?.default_sharing_enabled)}</p></details>;
  return <details><summary>عرض تغيير إتاحة البحث</summary><p>قبل التغيير: {status(data.before?.enabled)}</p><p>بعد التغيير: {status(data.after?.enabled)}</p></details>;
}
