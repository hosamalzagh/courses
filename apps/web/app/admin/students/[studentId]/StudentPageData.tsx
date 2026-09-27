import 'server-only';
import { loadStudentWorkspace } from '@/lib/server-context';
import { CenterAccessState } from '@/components/CenterAccessState';
import { CenterPage } from '@/components/CenterPage';
import { PrefetchLink as Link } from '@/components/PrefetchLink';
import { StudentStatusPanel } from '../StudentStatusPanel';
import { StudentSharingControls } from '../StudentSharingControls';
import { StudentProfileActions } from '../StudentProfileActions';

export async function StudentPageData({ params, searchParams }: { params: Promise<{ studentId: string }>; searchParams: Promise<{ status_page?: string }> }) {
  const { studentId } = await params;
  const { status_page } = await searchParams;
  const query = new URLSearchParams(status_page ? { status_page } : {}).toString();
  const context = await loadStudentWorkspace(query, studentId);
  if (typeof context === 'string') return <CenterAccessState state={context} />;
  const student = context.students[0];
  const value = (text: string | null) => text || 'لم تُضف بعد';
  return <CenterPage context={context} path={`/admin/students/${studentId}`}>
    <StudentProfileActions context={context} />
    <StudentSharingControls student={student} inHeader />
    <StudentStatusPanel context={context} />
    <Link href='/admin/students'>العودة إلى ملفات الطلاب</Link>
    <section className='context-card form-stack student-summary' aria-label='ملخص الطالب'>
      <h2>{student.name}</h2>
      <p>رقم الطالب الداخلي: <bdi>{student.student_number.toLocaleString('ar-EG')}</bdi></p>
      <p>رقم التواصل: <bdi dir='ltr'>{value(student.phone)}</bdi></p>
      <p>الفروع المصرح بها: {student.branch_ids.map((id) => context.branches.find((branch) => branch.id === id)?.name ?? `فرع رقم ${id}`).join('، ')}</p>
    </section>
    <nav className='form-actions' aria-label='أقسام ملف الطالب'><a href='#student-personal' aria-current='page'>البيانات الشخصية</a>{context.permissions.can_manage_center || Object.values(context.permissions.branch_roles).some((roles) => roles.includes('branch_auditor')) ? <Link href='/admin/audit'>سجل التغييرات</Link> : null}</nav>
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
        <div><dt>أدخل الملف</dt><dd>موظف رقم {student.created_by.toLocaleString('ar-EG')}</dd></div>
        <div><dt>تاريخ الإنشاء</dt><dd>{new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Cairo' }).format(new Date(student.created_at.replace(' ', 'T') + 'Z'))}</dd></div>
      </dl>
    </section>
  </CenterPage>;
}
