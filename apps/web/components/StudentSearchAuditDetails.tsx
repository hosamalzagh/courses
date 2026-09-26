import type { AuditEntry } from '@/lib/server-context';

export function StudentSearchAuditDetails({ entry }: { entry: AuditEntry }) {
  if (entry.event !== 'center.student_search_changed') return null;
  let details = entry.details;
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch { return null; }
  }
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const data = details as { before?: { enabled?: unknown }; after?: { enabled?: unknown } };
  const status = (value: unknown) => value === true ? 'مفعّل' : value === false ? 'مغلق' : 'غير مسجل';
  return <details><summary>عرض تغيير إتاحة البحث</summary><p>قبل التغيير: {status(data.before?.enabled)}</p><p>بعد التغيير: {status(data.after?.enabled)}</p></details>;
}
