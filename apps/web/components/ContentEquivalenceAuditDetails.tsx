import type { AuditEntry } from '@/lib/server-context';

export function ContentEquivalenceAuditDetails({ entry }: { entry: AuditEntry }) {
  if (entry.event !== 'content.equivalence_approved') return null;
  let details = entry.details;
  if (typeof details === 'string') { try { details = JSON.parse(details); } catch { return null; } }
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const record = details as { record_id?: unknown; reason?: unknown;
    after?: { source?: { plan_version_id?: unknown; lectures?: unknown }; target?: { plan_version_id?: unknown; lectures?: unknown } } };
  const local = record.after;
  if (!local || typeof local !== 'object') return null;
  const lectureList = (value: unknown) => Array.isArray(value) ? <ol className='list-decimal ps-6'>
    {value.filter((lecture): lecture is { number?: number; content?: string; title?: string } => Boolean(lecture) && typeof lecture === 'object')
      .map((lecture, index) => <li key={index}>
      {typeof lecture.number === 'number' ? lecture.number.toLocaleString('ar-EG') : '؟'}: {String(lecture.content ?? '')}
      {lecture.title ? ` · ${lecture.title}` : ''}
    </li>)}
  </ol> : null;
  return <details><summary>عرض اعتماد معادلة المحتوى</summary>
    <p>سبب الاعتماد: {typeof record.reason === 'string' ? record.reason : 'غير مسجل'}</p>
    {local.source ? <div><p>إصدار المصدر: <bdi>{String(local.source.plan_version_id ?? '')}</bdi></p>{lectureList(local.source.lectures)}</div> : null}
    {local.target ? <div><p>إصدار الوجهة: <bdi>{String(local.target.plan_version_id ?? '')}</bdi></p>{lectureList(local.target.lectures)}</div> : null}
    <p>معرّف الاعتماد: <bdi>{typeof record.record_id === 'string' ? record.record_id : 'غير مسجل'}</bdi></p>
  </details>;
}
