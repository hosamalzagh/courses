import { customFieldTypeLabels } from '@/lib/student-custom-fields';
import type { StudentCustomField } from '@/lib/server-context';
import { StudentContactSummary } from './StudentContactSummary';
import type { StudentContactsData } from '@/lib/server-context';
import { studentChoiceLabels } from '@/lib/student-profile-choices';
import type { AuditEntry } from '@/lib/server-context';

export function StudentAuditDetails({ entry }: { entry: AuditEntry }) {
  if (entry.event === 'student.photo_changed') return <p>حُفظت صورة شخصية جديدة للطالب. محتوى الصور يعرض داخل الملف المصرح به.</p>;
  if (entry.event === 'center.student_custom_field_changed') {
    let details=entry.details;if(typeof details === 'string') {try{details=JSON.parse(details);}catch{return null;}}
    if(!details || typeof details !== 'object' || Array.isArray(details) || !('after' in details) || !details.after)return null;
    const data=details as {before:StudentCustomField|null;after:StudentCustomField};
    const label=(field:StudentCustomField|null)=>field ? `${field.label} · ${customFieldTypeLabels[field.type]} · ترتيب ${field.position} · ${field.required ? 'مطلوب' : 'اختياري'} · ${field.classification === 'identity' ? 'هوية مقيدة' : 'عام'} · ${field.active === false ? 'معطل' : 'فعال'}${field.disabled_options?.length ? ` · اختيارات معطلة: ${field.disabled_options.join('، ')}` : ''}` : 'حقل جديد';
    return <details><summary>عرض تغيير الحقل الإضافي</summary><p>قبل: {label(data.before)}</p><p>بعد: {label(data.after)}</p></details>;
  }
  if (entry.event === 'center.student_code_settings_changed') {
    let details = entry.details;
    if (typeof details === 'string') {try {details=JSON.parse(details);} catch {return null;}}
    if (!details || typeof details !== 'object' || Array.isArray(details) || !('before' in details) || !('after' in details) || !details.before || !details.after) return null;
    const data = details as {before:{enabled:boolean;label:string};after:{enabled:boolean;label:string}};
    return <details><summary>عرض تغيير الباركود الإضافي</summary><p>قبل: {data.before.label} — {data.before.enabled ? 'مفعل' : 'معطل'}</p><p>بعد: {data.after.label} — {data.after.enabled ? 'مفعل' : 'معطل'}</p></details>;
  }
  if (entry.event === 'center.student_profile_choice_changed') {
    let details = entry.details;
    if (typeof details === 'string') { try { details = JSON.parse(details); } catch { return null; } }
    if (!details || typeof details !== 'object' || Array.isArray(details) || !('after' in details) || !details.after) return null;
    const data = details as { before: { label: string; active: boolean; position: number } | null; after: { label: string; active: boolean; position: number; kind: keyof typeof studentChoiceLabels } };
    const value = (choice: typeof data.before) => choice ? `${choice.label} · ترتيب ${choice.position} · ${choice.active ? 'متاح' : 'معطل'}` : 'اختيار جديد';
    return <details><summary>عرض تغيير قائمة الطالب</summary><p>{studentChoiceLabels[data.after.kind]}</p><p>قبل التغيير: {value(data.before)}</p><p>بعد التغيير: {value(data.after)}</p></details>;
  }
  if (entry.event === 'student.sharing_changed') {
    let details = entry.details;
    if (typeof details === 'string') { try { details = JSON.parse(details); } catch { return null; } }
    if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
    const data = details as { before?: { sharing_enabled?: boolean }; after?: { sharing_enabled?: boolean } };
    const status = (value?: boolean) => value === true ? 'مسموحة' : value === false ? 'مغلقة' : 'غير مسجل';
    return <details><summary>عرض تغيير مشاركة الطالب</summary><p>قبل التغيير: {status(data.before?.sharing_enabled)}</p><p>بعد التغيير: {status(data.after?.sharing_enabled)}</p></details>;
  }
  if (!['student.created', 'student.updated', 'student.suspended', 'student.reactivated'].includes(entry.event)) return null;
  let details = entry.details;
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch { return null; }
  }
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const data = details as Record<string, unknown>;
  if (['student.suspended', 'student.reactivated'].includes(entry.event)) return <details><summary>عرض تغيير حالة الطالب</summary><p>قبل التغيير: {data.before === 'active' ? 'نشط' : 'موقوف'}</p><p>بعد التغيير: {data.after === 'active' ? 'نشط' : 'موقوف'}</p><p>السبب: {typeof data.reason === 'string' ? data.reason : ''}</p></details>;
  function basic(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'لم يكن الملف موجودًا';
    const record = value as Record<string, unknown>;
    const labels: Record<string, string> = { date_of_birth: 'تاريخ الميلاد', gender: 'النوع', address: 'العنوان', email: 'البريد', school: 'المدرسة / جهة الدراسة', employer: 'جهة العمل', specialization: 'التخصص' };
    return <>{typeof record.name === 'string' ? record.name : 'غير مسجل'} · رقم {typeof record.student_number === 'number' ? record.student_number.toLocaleString('ar-EG') : 'غير مسجل'} · التواصل: <bdi>{typeof record.phone === 'string' ? record.phone : 'غير مسجل'}</bdi>{typeof record.manual_code === 'string' ? <span> · الباركود الإضافي: <bdi dir='ltr'>{record.manual_code}</bdi></span> : null}{record.profile_choices && typeof record.profile_choices === 'object' ? Object.entries(record.profile_choices).map(([kind, choice]) => <span key={kind}> · {studentChoiceLabels[kind as keyof typeof studentChoiceLabels]}: {(choice as { label: string }).label}</span>) : null}{Object.entries(labels).filter(([key]) => key in record).map(([key, label]) => <span key={key}> · {label}: {typeof record[key] === 'string' ? (key === 'gender' ? record[key] === 'male' ? 'ذكر' : 'أنثى' : record[key]) : 'لم يُضف'}</span>)}</>;
  }
  const contacts = (value: unknown) => value && typeof value === 'object' && 'contacts' in value && 'channels' in value ? <StudentContactSummary data={value as StudentContactsData} legacyPhone={'legacy_phone' in value && typeof value.legacy_phone === 'string' ? value.legacy_phone : null} /> : null;
  const changedIdentity = Array.isArray(data.identity_changed) ? data.identity_changed.filter(field => field === 'national_id' || field === 'passport_number') : [];
  return <details><summary>عرض تغيير ملف الطالب</summary>{changedIdentity.length ? <p>تغيرت بيانات الهوية: {changedIdentity.map(field => field === 'national_id' ? 'الرقم القومي' : 'الجواز').join('، ')}. القيم مقيدة ولا تعرض في السجل العام.</p> : null}{Array.isArray(data.custom_fields_changed) && data.custom_fields_changed.length ? <p>تغيرت قيم {data.custom_fields_changed.length.toLocaleString('ar-EG')} من الحقول الإضافية. القيم تعرض داخل الملف المصرح به.</p> : null}<p>قبل التغيير: {basic(data.before)}</p>{contacts(data.before)}<p>بعد التغيير: {basic(data.after)}</p>{contacts(data.after)}<p>ارتباط الطالب بهذا الفرع: {data.associated_before === true ? 'كان مرتبطًا بالفعل' : 'ارتباط جديد'}</p></details>;
}
