import type { AuditEntry } from '@/lib/server-context';
export function CurriculumAuditDetails({ entry }: { entry: AuditEntry }) {
  if (!entry.event.startsWith('curriculum.')) return null;
  let details = entry.details;
  if (typeof details === 'string') { try { details = JSON.parse(details); } catch { return null; } }
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const data = details as Record<string, unknown>;
  function value(record: unknown) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return <p>لم يكن السجل موجودًا</p>;
    const item = record as Record<string, unknown>;
    const plan = item.plan && typeof item.plan === 'object' && !Array.isArray(item.plan) ? item.plan as Record<string, unknown> : null;
    const lectures = plan && Array.isArray(plan.lectures) ? plan.lectures.filter((lecture): lecture is Record<string, unknown> => Boolean(lecture && typeof lecture === 'object' && !Array.isArray(lecture))) : [];
    return <><p>{typeof item.name === 'string' ? item.name : 'اسم غير مسجل'}{typeof item.course_name === 'string' ? ` · ${item.course_name}` : ''}{typeof item.stage_name === 'string' ? ` · ${item.stage_name}` : ''}</p>{plan ? <><p>إصدار الخطة: {typeof plan.version === 'number' ? plan.version.toLocaleString('ar-EG') : 'غير مسجل'} · معرّف ثابت: <bdi>{typeof plan.id === 'string' ? plan.id : 'غير مسجل'}</bdi></p><ul>{lectures.map((lecture, index) => <li key={index}>المحاضرة {typeof lecture.number === 'number' ? lecture.number.toLocaleString('ar-EG') : 'غير مسجلة'}: {typeof lecture.content === 'string' ? lecture.content : 'غير مسجل'} · {typeof lecture.title === 'string' ? lecture.title : 'بدون عنوان'} · {typeof lecture.planned_hours === 'number' ? lecture.planned_hours.toLocaleString('ar-EG') : 'غير مسجل'} ساعة مخططة</li>)}</ul></> : null}</>;
  }
  return <details><summary>عرض تغيير المنهج</summary><h4>قبل التغيير</h4>{value(data.before)}<h4>بعد التغيير</h4>{value(data.after)}</details>;
}
