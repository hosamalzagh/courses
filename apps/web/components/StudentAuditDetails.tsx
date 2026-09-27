import type { AuditEntry } from '@/lib/server-context';

export function StudentAuditDetails({ entry }: { entry: AuditEntry }) {
  if (!['student.created', 'student.updated'].includes(entry.event)) return null;
  let details = entry.details;
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch { return null; }
  }
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const data = details as Record<string, unknown>;
  function basic(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'لم يكن الملف موجودًا';
    const record = value as Record<string, unknown>;
    const labels: Record<string, string> = { date_of_birth: 'تاريخ الميلاد', gender: 'النوع', address: 'العنوان', email: 'البريد', school: 'المدرسة / جهة الدراسة', employer: 'جهة العمل', specialization: 'التخصص' };
    return <>{typeof record.name === 'string' ? record.name : 'غير مسجل'} · رقم {typeof record.student_number === 'number' ? record.student_number.toLocaleString('ar-EG') : 'غير مسجل'} · التواصل: <bdi>{typeof record.phone === 'string' ? record.phone : 'غير مسجل'}</bdi>{Object.entries(labels).filter(([key]) => key in record).map(([key, label]) => <span key={key}> · {label}: {typeof record[key] === 'string' ? (key === 'gender' ? record[key] === 'male' ? 'ذكر' : 'أنثى' : record[key]) : 'لم يُضف'}</span>)}</>;
  }
  return <details><summary>عرض تغيير ملف الطالب</summary><p>قبل التغيير: {basic(data.before)}</p><p>بعد التغيير: {basic(data.after)}</p><p>ارتباط الطالب بهذا الفرع: {data.associated_before === true ? 'كان مرتبطًا بالفعل' : 'ارتباط جديد'}</p></details>;
}
