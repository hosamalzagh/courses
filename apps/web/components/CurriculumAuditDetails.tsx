import type { AuditEntry } from '@/lib/server-context';
export function CurriculumAuditDetails({ entry }: { entry: AuditEntry }) {
  if (!entry.event.startsWith('curriculum.') && !entry.event.startsWith('study_group.')) return null;
  let details = entry.details;
  if (typeof details === 'string') { try { details = JSON.parse(details); } catch { return null; } }
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const data = details as Record<string, unknown>;
  if (entry.event === 'curriculum.course_copied') {
    const counts = data.counts && typeof data.counts === 'object' && !Array.isArray(data.counts)
      ? data.counts as Record<string, unknown> : {};
    return <details><summary>عرض مصدر نسخة المنهج</summary>
      <p>الكورس الجديد: {typeof data.copied_course_name === 'string' ? data.copied_course_name : 'غير مسجل'}</p>
      <p>المصدر: {typeof data.source_course_name === 'string' && typeof data.source_branch_name === 'string'
        ? `${data.source_course_name} · ${data.source_branch_name}` : 'فرع غير متاح ضمن صلاحيتك'}</p>
      <p>نُسخ {Number(counts.stages ?? 0).toLocaleString('ar-EG')} مرحلة، {Number(counts.levels ?? 0).toLocaleString('ar-EG')} مستوى، {Number(counts.plans ?? 0).toLocaleString('ar-EG')} إصدار خطة.</p>
    </details>;
  }
  if (entry.event.startsWith('study_group.')) {
    const group = (record: unknown) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return 'لم تكن المجموعة موجودة';
      const item = record as Record<string, unknown>;
      const instructors = Array.isArray(item.instructors) ? item.instructors
        .filter((person): person is { name: string } => Boolean(person && typeof person === 'object' && typeof person.name === 'string'))
        .map(person => person.name).join('، ') : '';
      return <>{typeof item.name === 'string' ? item.name : 'بدون اسم'} · {item.status === 'waiting' ? 'تنتظر البدء' : item.status === 'started' ? 'بدأت' : 'مكتملة'} · السعر {typeof item.approved_price === 'string' ? item.approved_price : 'غير مسجل'} · نسبة الإتمام {typeof item.completion_threshold === 'number' ? `${item.completion_threshold.toLocaleString('ar-EG')}٪` : 'غير مسجلة'} · إصدار الخطة {typeof item.plan_version === 'number' ? item.plan_version.toLocaleString('ar-EG') : 'غير مسجل'} · المحاضرون: {instructors || 'غير مسجلين'}</>;
    };
    return <details><summary>عرض تغيير المجموعة</summary><p>قبل التغيير: {group(data.before)}</p><p>بعد التغيير: {group(data.after)}</p></details>;
  }
  if (entry.event === 'curriculum.completion_threshold_changed') {
    const value = (record: unknown) => record && typeof record === 'object' && !Array.isArray(record)
      ? record as Record<string, unknown> : null;
    const before = value(data.before);
    const after = value(data.after);
    return <details><summary>عرض تغيير نسبة الإتمام</summary>
      <p>{typeof after?.name === 'string' ? after.name : 'بدون اسم'} · {data.kind === 'courses' ? 'كورس' : data.kind === 'stages' ? 'مرحلة' : 'مستوى'}</p>
      <p>قبل: {typeof before?.completion_threshold === 'number' ? `${before.completion_threshold.toLocaleString('ar-EG')}٪` : 'موروثة'}</p>
      <p>بعد: {typeof after?.completion_threshold === 'number' ? `${after.completion_threshold.toLocaleString('ar-EG')}٪` : 'موروثة'}</p>
    </details>;
  }
  function value(record: unknown) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return <p>لم يكن السجل موجودًا</p>;
    const item = record as Record<string, unknown>;
    const plan = item.plan && typeof item.plan === 'object' && !Array.isArray(item.plan) ? item.plan as Record<string, unknown> : null;
    const lectures = plan && Array.isArray(plan.lectures) ? plan.lectures.filter((lecture): lecture is Record<string, unknown> => Boolean(lecture && typeof lecture === 'object' && !Array.isArray(lecture))) : [];
    return <><p>{typeof item.name === 'string' ? item.name : 'اسم غير مسجل'}{typeof item.course_name === 'string' ? ` · ${item.course_name}` : ''}{typeof item.stage_name === 'string' ? ` · ${item.stage_name}` : ''}</p>{plan ? <><p>إصدار الخطة: {typeof plan.version === 'number' ? plan.version.toLocaleString('ar-EG') : 'غير مسجل'} · معرّف ثابت: <bdi>{typeof plan.id === 'string' ? plan.id : 'غير مسجل'}</bdi></p><ul>{lectures.map((lecture, index) => <li key={index}>المحاضرة {typeof lecture.number === 'number' ? lecture.number.toLocaleString('ar-EG') : 'غير مسجلة'}: {typeof lecture.content === 'string' ? lecture.content : 'غير مسجل'} · {typeof lecture.title === 'string' ? lecture.title : 'بدون عنوان'} · {typeof lecture.planned_hours === 'number' ? lecture.planned_hours.toLocaleString('ar-EG') : 'غير مسجل'} ساعة مخططة</li>)}</ul></> : null}</>;
  }
  return <details><summary>عرض تغيير المنهج</summary><h4>قبل التغيير</h4>{value(data.before)}<h4>بعد التغيير</h4>{value(data.after)}</details>;
}
