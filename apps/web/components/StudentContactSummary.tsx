import { studentChannelLabels } from '@/lib/student-contacts';
import type { StudentContactsData, StudentChannelKind } from '@/lib/server-context';
export function StudentContactSummary({ data, legacyPhone }: { data: StudentContactsData; legacyPhone: string | null }) {
  return <div className='form-stack'>
    {data.contacts.map(contact => <div key={contact.id}><p>{contact.name} — {contact.relationship}{contact.primary ? ' — أساسية' : ''}</p><bdi dir='ltr'>{contact.phone}</bdi></div>)}
    {(Object.keys(studentChannelLabels) as StudentChannelKind[]).map(kind => {
      const channel = data.channels[kind];
      const contact = data.contacts.find(contact => contact.id === channel?.contact_id);
      return channel && contact ? <div key={kind}><p>{studentChannelLabels[kind]}: {contact.name}</p><bdi dir='ltr'>{channel.phone}</bdi></div> : null;
    })}
    {legacyPhone !== null ? <p>رقم سابق — صاحبه غير محدد: <bdi dir='ltr'>{legacyPhone}</bdi></p> : null}
    {!data.contacts.length && legacyPhone === null ? <p className='muted'>لم تُضف بيانات تواصل.</p> : null}
  </div>;
}
