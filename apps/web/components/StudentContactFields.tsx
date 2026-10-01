'use client';
import { useState } from 'react';
import { ConfirmationDialog } from './ConfirmationDialog';
import { CenterHeaderActions } from './CenterShell';
import { Button } from './Button';
import { ChoiceField } from './ChoiceField';
import { FormField } from './FormField';
import { FieldSet, FieldLegend } from './ui/field';
import { InlineNotice } from './InlineNotice';
import { newSubmissionId } from '@/lib/client-api';
import { studentChannelLabels } from '@/lib/student-contacts';
import type { StudentChannelKind, StudentContactsData } from '@/lib/server-context';

export function StudentContactFields({ prefix, data, onChange, errors, disabled }: {
  prefix: string; data: StudentContactsData; onChange: (value: StudentContactsData) => void; errors: Record<string, string>; disabled: boolean;
}) {
  const [removal, setRemoval] = useState<string | null>(null);
  function add() {
    const trigger = document.activeElement;
    const contact = { id: newSubmissionId(), name: '', relationship: '', phone: '', primary: data.contacts.length === 0 };
    onChange({ ...data, contacts: [...data.contacts, contact] });
    requestAnimationFrame(() => {
      if (document.activeElement === trigger) document.getElementById(`${prefix}-contact-${contact.id}-name`)?.focus();
    });
  }
  function remove(id: string) {
    const contacts = data.contacts.filter(contact => contact.id !== id);
    if (contacts.length && !contacts.some(contact => contact.primary)) contacts[0] = { ...contacts[0], primary: true };
    const channels = { ...data.channels };
    for (const kind of Object.keys(studentChannelLabels) as StudentChannelKind[]) if (channels[kind]?.contact_id === id) channels[kind] = null;
    onChange({ contacts, channels });
    setRemoval(null);
    requestAnimationFrame(() => document.getElementById(`${prefix}-add-contact`)?.focus());
  }
  const options = data.contacts.map((contact, index) => ({ value: contact.id, label: `${contact.name || `جهة ${index + 1}`} — ${contact.relationship || 'صلة غير محددة'}` }));
  return <><FieldSet disabled={disabled}>
    <FieldLegend>جهات التواصل وقنوات المتابعة</FieldLegend>
    <p className='muted'>ولي الأمر اختياري. يمكن مشاركة الرقم بين الطلاب والقنوات؛ الحفظ لا يرسل رسائل ولا يربط حسابًا خارجيًا. حتى 20 جهة لكل طالب.</p>
    <CenterHeaderActions>
      <Button id={`${prefix}-add-contact`} disabled={disabled || data.contacts.length >= 20} onClick={add}>إضافة جهة تواصل</Button>
      <span className='flex flex-wrap gap-2 ms-2'>{data.contacts.map((contact, index) => <Button key={contact.id} variant='danger' disabled={disabled} onClick={() => setRemoval(contact.id)}>حذف جهة التواصل {index + 1}</Button>)}</span>
    </CenterHeaderActions>
    {errors.contacts || errors.channels ? <InlineNotice tone='error'>{errors.contacts || errors.channels}</InlineNotice> : null}
    {!data.contacts.length ? <p className='muted'>لم تُضف جهات تواصل. بيانات التواصل اختيارية.</p> : <ChoiceField id={`${prefix}-primary-contact`} label='جهة التواصل الأساسية' value={data.contacts.find(contact => contact.primary)?.id ?? ''} items={options} error={errors.contacts} disabled={disabled} onChange={id => onChange({ ...data, contacts: data.contacts.map(contact => ({ ...contact, primary: contact.id === id })) })} />}
    {data.contacts.map((contact, index) => <FieldSet key={contact.id}><FieldLegend>جهة التواصل {index + 1}</FieldLegend><div className='student-fields'>
      {([['name', 'اسم جهة التواصل'], ['relationship', 'الصلة بالطالب'], ['phone', 'هاتف جهة التواصل']] as const).map(([field, label]) => <FormField key={field} id={`${prefix}-contact-${contact.id}-${field}`} label={`${label} ${index + 1}`} value={contact[field]} required type={field === 'phone' ? 'tel' : 'text'} direction={field === 'phone' ? 'ltr' : undefined} error={errors[`contacts.${index}.${field}`]} onChange={value => onChange({ ...data, contacts: data.contacts.map(row => row.id === contact.id ? { ...row, [field]: value } : row) })} />)}
    </div></FieldSet>)}
    {data.contacts.length ? <FieldSet><FieldLegend>قنوات المتابعة</FieldLegend><div className='student-fields'>{(Object.keys(studentChannelLabels) as StudentChannelKind[]).map(kind => <FieldSet key={kind}><FieldLegend>{studentChannelLabels[kind]}</FieldLegend>
      <ChoiceField id={`${prefix}-channel-${kind}-owner`} label={`صاحب قناة ${studentChannelLabels[kind]}`} value={data.channels[kind]?.contact_id ?? ''} disabled={disabled} items={[{ value: '', label: 'لم تُحدد' }, ...options]} error={errors[`channels.${kind}.contact_id`]} onChange={id => onChange({ ...data, channels: { ...data.channels, [kind]: id ? { contact_id: id, phone: data.channels[kind]?.phone || data.contacts.find(contact => contact.id === id)?.phone || '' } : null } })} />
      {data.channels[kind] ? <FormField id={`${prefix}-channel-${kind}-phone`} label={`رقم قناة ${studentChannelLabels[kind]}`} type='tel' direction='ltr' required value={data.channels[kind]!.phone} error={errors[`channels.${kind}.phone`]} onChange={phone => onChange({ ...data, channels: { ...data.channels, [kind]: { ...data.channels[kind]!, phone } } })} /> : null}
    </FieldSet>)}</div></FieldSet> : null}
  </FieldSet>{removal ? <ConfirmationDialog title='حذف جهة التواصل' description={`حذف ${data.contacts.find(contact => contact.id === removal)?.name || 'هذه الجهة'} وقنوات المتابعة المرتبطة بها من التعديل الحالي. يثبت الحذف عند حفظ الملف؛ ويبقى سجل التغييرات محفوظًا.`} confirmLabel='حذف جهة التواصل' onCancel={() => setRemoval(null)} onConfirm={() => remove(removal)} /> : null}</>;
}
