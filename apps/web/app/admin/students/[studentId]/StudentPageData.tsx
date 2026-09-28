import 'server-only';
import Image from 'next/image';
import { StudentPhotoControls } from '@/components/StudentPhotoControls';
import { StudentAttachments } from '@/components/StudentAttachments';
import { StudentCustomFieldHistory } from '@/components/StudentCustomFieldHistory';
import { StudentCustomFieldSummary } from '@/components/StudentCustomFields';
import { InlineNotice } from '@/components/InlineNotice';
import { StudentContactSummary } from '@/components/StudentContactSummary';
import { studentChoiceLabels } from '@/lib/student-profile-choices';
import type { StudentChoiceKind } from '@/lib/server-context';
import { loadStudentWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { CenterPage } from '@/components/CenterPage';
import { PrefetchLink as Link } from '@/components/PrefetchLink';
import { StudentStatusPanel } from '../StudentStatusPanel';
import { StudentSharingControls } from '../StudentSharingControls';
import { StudentProfileActions } from '../StudentProfileActions';

export async function StudentPageData({ params, searchParams }: { params: Promise<{ studentId: string }>; searchParams: Promise<{ status_page?: string; tab?:string; custom_history_page?:string; attachments_page?:string; attachments_status?:string }> }) {
  const { studentId } = await params;
  const { status_page, tab, custom_history_page, attachments_page, attachments_status } = await searchParams;
  const query = new URLSearchParams({...status_page ? {status_page} : {}, ...tab === 'custom-history' ? {tab,...custom_history_page ? {custom_history_page} : {}} : {}, ...tab === 'attachments' ? {tab,...attachments_page ? {attachments_page} : {},...attachments_status ? {attachments_status} : {}} : {}}).toString();
  const context = await loadStudentWorkspace(query, studentId);
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  const student = context.students[0];
  const primaryContact = student.contacts.find(contact => contact.id === student.channels.primary?.contact_id) ?? student.contacts.find(contact => contact.primary);
  const value = (text: string | null) => text || 'لم تُضف بعد';
  return <CenterPage context={context} path={`/admin/students/${studentId}`}>
    <StudentProfileActions context={context} />
    <StudentSharingControls student={student} inHeader />
    <StudentStatusPanel context={context} />
    <Link href='/admin/students'>العودة إلى ملفات الطلاب</Link>
    <section className='context-card form-stack student-summary' aria-label='ملخص الطالب'>
      {student.photo ? <Image src={student.photo.preview} alt={`صورة ${student.name}`} width={96} height={96} unoptimized className='rounded-lg object-cover' /> : <p>لم تُضف صورة للطالب بعد.</p>}
      <h2>{student.name}</h2>
      <p>رقم الطالب الداخلي: <bdi>{student.student_number.toLocaleString('ar-EG')}</bdi></p>
      {student.manual_code !== null ? <p>{context.student_code_settings.label}{context.student_code_settings.enabled ? '' : ' — معطل، والقيمة محفوظة'}: <bdi dir='ltr'>{student.manual_code}</bdi></p> : null}
      <p>رقم التواصل: <bdi dir='ltr'>{value(student.phone)}</bdi>{primaryContact ? ` — ${primaryContact.name} (${primaryContact.relationship})` : student.phone ? ' — صاحبه غير محدد' : ''}</p>
      <p>الفروع المصرح بها: {student.branch_ids.map((id) => context.branches.find((branch) => branch.id === id)?.name ?? `فرع رقم ${id}`).join('، ')}</p>
    </section>
    {!tab ? <StudentPhotoControls key={student.id} student={student} /> : null}
    {student.missing_custom_fields > 0 ? <InlineNotice tone='warning'>الملف ينقصه {student.missing_custom_fields.toLocaleString('ar-EG')} من الحقول المطلوبة. أكملها عند تعديل البيانات؛ المشاركة والإيقاف مستقلان.</InlineNotice> : null}
    <nav className='form-actions' aria-label='أقسام ملف الطالب'><Link href={`/admin/students/${student.id}`} aria-current={!tab ? 'page' : undefined}>البيانات الشخصية</Link><Link href={`/admin/students/${student.id}?tab=attachments`} aria-current={tab === 'attachments' ? 'page' : undefined}>المرفقات</Link><Link href={`/admin/students/${student.id}?tab=custom-history`} aria-current={tab === 'custom-history' ? 'page' : undefined}>تاريخ الحقول الإضافية</Link>{context.permissions.can_manage_center || student.branch_ids.some((id) => context.permissions.branch_actions?.[String(id)]?.includes('enrollment.manage')) ? <Link href={`/admin/students/${student.id}/enrollments`}>التسجيل ومحاولات الدراسة</Link> : null}{context.permissions.can_manage_center || student.branch_ids.some((id) => context.permissions.branch_actions?.[String(id)]?.includes('finance.read')) ? <Link href={`/admin/students/${student.id}/account`}>الحساب المالي</Link> : null}{context.permissions.can_manage_center || Object.values(context.permissions.branch_roles).some((roles) => roles.includes('branch_auditor')) ? <Link href='/admin/audit'>سجل التغييرات</Link> : null}</nav>
    {context.attachments ? <StudentAttachments key={`${student.id}-${context.attachments.status}-${context.attachments.pagination.page}`} student={student} page={context.attachments} canRestore={context.permissions.can_manage_center} /> : context.custom_history ? <StudentCustomFieldHistory history={context.custom_history} studentId={student.id} /> : <>
    <section id='student-personal' className='context-card form-stack' aria-labelledby='student-personal-title'>
      <h2 id='student-personal-title'>البيانات الشخصية</h2>
      <dl className='student-fields student-data'>
        <div><dt>تاريخ الميلاد</dt><dd><bdi>{value(student.date_of_birth)}</bdi></dd></div>
        <div><dt>العمر</dt><dd>{student.age === null ? 'لم يُضف تاريخ الميلاد' : `${student.age.toLocaleString('ar-EG')} سنة`}</dd></div>
        <div><dt>النوع</dt><dd>{student.gender === 'male' ? 'ذكر' : student.gender === 'female' ? 'أنثى' : 'لم يُضف بعد'}</dd></div>
        <div><dt>العنوان</dt><dd>{value(student.address)}</dd></div>
        <div><dt>البريد الإلكتروني</dt><dd><bdi>{value(student.email)}</bdi></dd></div>
        <div><dt>المدرسة / جهة الدراسة</dt><dd>{value(student.school)}</dd></div>
        <div><dt>جهة العمل</dt><dd>{value(student.employer)}</dd></div>
        <div><dt>التخصص</dt><dd>{value(student.specialization)}</dd></div>
        {(Object.keys(studentChoiceLabels) as StudentChoiceKind[]).map(kind => <div key={kind}><dt>{studentChoiceLabels[kind]}</dt><dd>{student.profile_choices[kind] ? `${student.profile_choices[kind]!.label}${student.profile_choices[kind]!.active ? '' : ' — معطل'}` : 'لم يُضف بعد'}</dd></div>)}
        <div><dt>أدخل الملف</dt><dd>موظف رقم {student.created_by.toLocaleString('ar-EG')}</dd></div>
        <div><dt>تاريخ الإنشاء</dt><dd>{new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Cairo' }).format(new Date(student.created_at.replace(' ', 'T') + 'Z'))}</dd></div>
      </dl>
    </section>
    {student.identity ? <section className='context-card form-stack' aria-label='بيانات الهوية'><h2>بيانات الهوية</h2><dl className='student-fields student-data'><div><dt>الرقم القومي المصري</dt><dd><bdi dir='ltr'>{value(student.identity.national_id)}</bdi></dd></div><div><dt>رقم جواز السفر</dt><dd><bdi dir='ltr'>{value(student.identity.passport_number)}</bdi></dd></div></dl></section> : null}
    <section className='context-card form-stack' aria-label='حقول الطالب الإضافية'><StudentCustomFieldSummary initial={context.custom_fields} initialValues={student.custom_values ?? {}} studentId={student.id} prefix={`profile-${student.id}`} /></section>
    <section className='context-card form-stack' aria-label='جهات التواصل وقنوات المتابعة'><h2>جهات التواصل وقنوات المتابعة</h2><StudentContactSummary data={student} legacyPhone={student.legacy_phone} /></section>
    </>}
  </CenterPage>;
}
