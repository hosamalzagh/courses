import type { Student, StudentChannelKind, StudentContactsData } from './server-context';
export const studentChannelLabels: Record<StudentChannelKind, string> = { primary: 'الهاتف الأساسي', alternative: 'الهاتف البديل', whatsapp: 'واتساب', sinjapp: 'سنجاب' };
export function studentContactsData(student?: Student): StudentContactsData {
  return { contacts: student?.contacts ?? [], channels: Object.fromEntries(Object.keys(studentChannelLabels).map(kind => [kind, student?.channels[kind as StudentChannelKind] ?? null])) as StudentContactsData['channels'] };
}
export function contactValidation(data: StudentContactsData): Record<string, string> {
  const errors: Record<string, string> = {};
  if (data.contacts.length && data.contacts.filter(contact => contact.primary).length !== 1) errors.contacts = 'حدد جهة تواصل أساسية واحدة.';
  data.contacts.forEach((contact, index) => {
    for (const field of ['name', 'relationship', 'phone'] as const) if (!contact[field].trim()) errors[`contacts.${index}.${field}`] = 'أكمل بيانات جهة التواصل.';
  });
  for (const [kind, channel] of Object.entries(data.channels)) if (channel && !channel.phone.trim()) errors[`channels.${kind}.phone`] = 'أدخل رقم القناة.';
  return errors;
}
