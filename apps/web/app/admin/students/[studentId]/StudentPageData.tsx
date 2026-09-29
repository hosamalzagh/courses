import 'server-only';
import type { ReactNode } from 'react';
import Image from 'next/image';
import { StudentPhotoControls } from '@/components/StudentPhotoControls';
import { StudentAttachments } from '@/components/StudentAttachments';
import { StudentCustomFieldHistory } from '@/components/StudentCustomFieldHistory';
import { StudentCustomFieldSummary } from '@/components/StudentCustomFields';
import { InlineNotice } from '@/components/InlineNotice';
import { StudentContactSummary } from '@/components/StudentContactSummary';
import { StudentEnrollmentNoteHistory } from '@/components/StudentEnrollmentNoteHistory';
import { StudentEventNotes } from '@/components/StudentEventNotes';
import { canOpenStudentEventNote, studentEventNoteOrigin } from '@/lib/student-event-notes';
import { studentChoiceLabels } from '@/lib/student-profile-choices';
import type { StudentChoiceKind } from '@/lib/server-context';
import { loadStudentWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { CenterPage } from '@/components/CenterPage';
import { PrefetchLink as Link } from '@/components/PrefetchLink';
import { StudentStatusPanel } from '../StudentStatusPanel';
import { StudentSharingControls } from '../StudentSharingControls';
import { StudentProfileActions } from '../StudentProfileActions';
import { StudentStudyTab } from './StudentStudyTab';
import { StudentAttendanceTab } from './StudentAttendanceTab';
import { Badge } from '@/components/ui/badge';

export async function StudentPageData({ params, searchParams }: { params: Promise<{ studentId: string }>; searchParams: Promise<{ status_page?: string; tab?:string; custom_history_page?:string; attachments_page?:string; attachments_status?:string; study_page?:string; study_q?:string; attendance_page?:string; attendance_q?:string }> }) {
  const { studentId } = await params;
  const { status_page, tab, custom_history_page, attachments_page, attachments_status, study_page, study_q, attendance_page, attendance_q } = await searchParams;
  const query = new URLSearchParams({...status_page ? {status_page} : {}, ...tab === 'custom-history' ? {tab,...custom_history_page ? {custom_history_page} : {}} : {}, ...tab === 'attachments' ? {tab,...attachments_page ? {attachments_page} : {},...attachments_status ? {attachments_status} : {}} : {}, ...tab === 'study' ? {tab,...study_page ? {study_page} : {},...study_q ? {study_q} : {}} : {}, ...tab === 'attendance' ? {tab,...attendance_page ? {attendance_page} : {},...attendance_q ? {attendance_q} : {}} : {}, ...tab === 'enrollment-notes' || tab === 'notes' ? {tab} : {}}).toString();
  const context = await loadStudentWorkspace(query, studentId);
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  const student = context.students[0];
  const primaryContact = student.contacts.find(contact => contact.id === student.channels.primary?.contact_id) ?? student.contacts.find(contact => contact.primary);
  const missing = <span className='student-empty-value' aria-label='غير مسجل'>—</span>;
  const personalDetails: { label: string; value: ReactNode }[] = [
    { label: 'تاريخ الميلاد', value: student.date_of_birth },
    { label: 'العمر', value: student.age === null ? null : `${student.age.toLocaleString('ar-EG')} سنة` },
    { label: 'النوع', value: student.gender === 'male' ? 'ذكر' : student.gender === 'female' ? 'أنثى' : null },
    { label: 'العنوان', value: student.address },
    { label: 'البريد الإلكتروني', value: student.email ? <bdi dir='ltr'>{student.email}</bdi> : null },
    { label: 'المدرسة / جهة الدراسة', value: student.school },
    { label: 'جهة العمل', value: student.employer },
    { label: 'التخصص', value: student.specialization },
    ...(Object.keys(studentChoiceLabels) as StudentChoiceKind[]).map(kind => ({ label: studentChoiceLabels[kind], value: student.profile_choices[kind] ? `${student.profile_choices[kind]!.label}${student.profile_choices[kind]!.active ? '' : ' — معطل'}` : null })),
  ].filter(field => field.value !== null && field.value !== '');
  const identityDetails = student.identity ? [
    { label: 'الرقم القومي المصري', value: student.identity.national_id },
    { label: 'رقم جواز السفر', value: student.identity.passport_number },
  ].filter(field => field.value) : [];
  const tabHref = (nextTab?: string) => {
    const params = new URLSearchParams();
    if (status_page) params.set('status_page', status_page);
    if (nextTab) params.set('tab', nextTab);
    return `/admin/students/${student.id}${params.size ? `?${params}` : ''}`;
  };
  return <CenterPage context={context} path={`/admin/students/${studentId}`} className='student-profile-page'>
    <StudentProfileActions context={context} tab={tab} />
    <Link className='student-back-link' href='/admin/students'>العودة إلى ملفات الطلاب</Link>
    <section className='context-card student-summary' aria-label='ملخص الطالب'>
      <div className='student-summary-heading'>
        <div className='student-avatar' aria-hidden='true'>
          {student.photo ? <Image src={student.photo.preview} alt='' width={80} height={80} unoptimized /> : student.name.trim().slice(0, 1)}
        </div>
        <div className='student-summary-name'>
          <p className='student-summary-kicker'>ملف طالب · رقم <bdi>{student.student_number.toLocaleString('ar-EG')}</bdi></p>
          <h2>{student.name}</h2>
          <div className='student-summary-badges'>
            <Badge variant={student.status === 'suspended' ? 'destructive' : 'secondary'}>{student.status === 'suspended' ? 'موقوف' : 'نشط'}</Badge>
            {student.manual_code !== null ? <Badge variant='outline'>{context.student_code_settings.label}: <bdi dir='ltr'>{student.manual_code}</bdi>{context.student_code_settings.enabled ? '' : ' · معطل'}</Badge> : null}
          </div>
        </div>
      </div>
      <div className='student-summary-facts'>
        <div><span>التواصل</span><strong>{student.phone ? <bdi dir='ltr'>{student.phone}</bdi> : missing}</strong>{primaryContact ? <small>{primaryContact.name} · {primaryContact.relationship}</small> : student.phone ? <small>صاحب الرقم غير محدد</small> : null}</div>
        <div><span>الفروع المرتبطة</span><strong>{student.branch_ids.map((id) => context.branches.find((branch) => branch.id === id)?.name ?? `فرع رقم ${id}`).join('، ')}</strong></div>
        <div><span>ظهور الملف بين الفروع</span><StudentSharingControls student={student} inHeader /></div>
        {context.summary ? <div><span>الدراسة الحالية</span><strong>{context.summary.current_study.length ? `${context.summary.current_study[0].course_name} · ${context.summary.current_study[0].level_name}` : 'لا توجد دراسة جارية'}</strong>{context.summary.current_study.length > 1 || context.summary.current_study_has_more ? <small>ومحاولات أخرى ضمن فروعك</small> : null}<Link href={`/admin/students/${student.id}?tab=study`}>عرض الدراسة</Link></div> : null}
      </div>
      {context.summary && (context.summary.current_group_absences > 0 || (context.summary.financial && Number(context.summary.financial.debt) > 0)) ? <div className='student-summary-alerts'>
        {context.summary.current_group_absences > 0 ? <InlineNotice tone='warning'>غيابات مسجلة في المجموعات الحالية: {context.summary.current_group_absences.toLocaleString('ar-EG')}.</InlineNotice> : null}
        {context.summary.financial && Number(context.summary.financial.debt) > 0 ? <InlineNotice tone='warning'>مديونية في الفروع المالية المصرح بها: {context.summary.financial.debt} {context.summary.financial.currency ?? ''}. <Link href={`/admin/students/${student.id}/account`}>فتح الحساب المالي</Link></InlineNotice> : null}
      </div> : null}
    </section>
    {context.important_notes?.length ? <section className='context-card form-stack' aria-label='الملاحظات المهمة'>
      <h2>ملاحظات مهمة</h2>
      <ul>{context.important_notes.map(note => <li key={note.id}>
        {canOpenStudentEventNote(note, context.permissions)
          ? <Link href={studentEventNoteOrigin(student.id, note)}>{note.body}{note.body.length >= 120 ? '…' : ''}</Link>
          : <span>{note.body}{note.body.length >= 120 ? '…' : ''}</span>}
      </li>)}</ul>
      <Link href={`/admin/students/${student.id}?tab=notes`}>عرض كل الملاحظات</Link>
    </section> : null}
    {student.missing_custom_fields > 0 ? <InlineNotice tone='warning'>الملف ينقصه {student.missing_custom_fields.toLocaleString('ar-EG')} من الحقول المطلوبة. أكملها عند تعديل البيانات؛ المشاركة والإيقاف مستقلان.</InlineNotice> : null}
    <nav className='student-profile-tabs' aria-label='أقسام ملف الطالب'>
      <Link href={tabHref()} aria-current={!tab ? 'page' : undefined}>البيانات الشخصية</Link>
      <Link href={tabHref('study')} aria-current={tab === 'study' ? 'page' : undefined}>الدراسة</Link>
      <Link href={tabHref('attendance')} aria-current={tab === 'attendance' ? 'page' : undefined}>الحضور والغياب</Link>
      <Link href={tabHref('attachments')} aria-current={tab === 'attachments' ? 'page' : undefined}>المرفقات</Link>
      <Link href={tabHref('custom-history')} aria-current={tab === 'custom-history' ? 'page' : undefined}>تاريخ الحقول الإضافية</Link>
      <Link href={tabHref('notes')} aria-current={tab === 'notes' ? 'page' : undefined}>الملاحظات</Link>
    </nav>
    <div className='student-profile-layout'>
      <div className='student-profile-main'>
    {tab === 'study' && context.study ? <StudentStudyTab context={context} search={study_q ?? ''} /> : tab === 'attendance' && context.attendance ? <StudentAttendanceTab context={context} search={attendance_q ?? ''} query={query} /> : tab === 'notes' && context.student_notes ? <StudentEventNotes key={student.id} studentId={student.id} initial={context.student_notes} permissions={context.permissions} /> : tab === 'enrollment-notes' && context.enrollment_notes ? <StudentEnrollmentNoteHistory key={student.id} studentId={student.id} initial={context.enrollment_notes} permissions={context.permissions} /> : context.attachments ? <StudentAttachments key={`${student.id}-${context.attachments.status}-${context.attachments.pagination.page}`} student={student} page={context.attachments} canRestore={context.permissions.can_manage_center} /> : context.custom_history ? <StudentCustomFieldHistory history={context.custom_history} studentId={student.id} /> : <>
    <section id='student-personal' className='context-card form-stack' aria-labelledby='student-personal-title'>
      <h2 id='student-personal-title'>البيانات الشخصية</h2>
      {personalDetails.length ? <dl className='student-fields student-data'>
        {personalDetails.map(field => <div key={field.label}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}
      </dl> : <p className='muted'>لا توجد بيانات شخصية إضافية مسجلة.</p>}
      <p className='student-profile-provenance'>أدخل الملف موظف رقم {student.created_by.toLocaleString('ar-EG')} · {new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Cairo' }).format(new Date(student.created_at.replace(' ', 'T') + 'Z'))}</p>
    </section>
    {identityDetails.length ? <section className='context-card form-stack' aria-label='بيانات الهوية'><h2>بيانات الهوية</h2><dl className='student-fields student-data'>{identityDetails.map(field => <div key={field.label}><dt>{field.label}</dt><dd><bdi dir='ltr'>{field.value}</bdi></dd></div>)}</dl></section> : null}
    <section className='context-card form-stack' aria-label='حقول الطالب الإضافية'><StudentCustomFieldSummary initial={context.custom_fields} initialValues={student.custom_values ?? {}} studentId={student.id} prefix={`profile-${student.id}`} /></section>
    <section className='context-card form-stack' aria-label='جهات التواصل وقنوات المتابعة'><h2>جهات التواصل وقنوات المتابعة</h2><StudentContactSummary data={student} legacyPhone={student.legacy_phone} /></section>
    </>}
      </div>
      <aside className='student-profile-side' aria-label='حالة الطالب وروابط الملف'>
        <StudentStatusPanel context={context} query={query} />
        {!tab ? <StudentPhotoControls key={student.id} student={student} /> : null}
        <nav className='context-card student-profile-related' aria-label='روابط الطالب'>
          <h2>روابط الطالب</h2>
          {context.permissions.can_manage_center || student.branch_ids.some((id) => context.permissions.branch_actions?.[String(id)]?.includes('enrollment.manage')) ? <Link href={`/admin/students/${student.id}/enrollments`}>التسجيل ومحاولات الدراسة</Link> : null}
          {context.permissions.can_manage_center || student.branch_ids.some((id) => context.permissions.branch_actions?.[String(id)]?.includes('finance.read')) ? <Link href={`/admin/students/${student.id}/account`}>الحساب المالي</Link> : null}
          {context.permissions.can_manage_center || Object.values(context.permissions.branch_roles).some((roles) => roles.includes('branch_auditor')) ? <Link href='/admin/audit'>سجل التغييرات</Link> : null}
        </nav>
      </aside>
    </div>
  </CenterPage>;
}
