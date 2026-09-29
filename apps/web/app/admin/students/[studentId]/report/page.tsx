import 'server-only';
import type { Metadata } from 'next';
import { CenterAccessState } from '@/components/CenterAccessState';
import { CenterPage } from '@/components/CenterPage';
import { CenterPageActions } from '@/components/CenterShell';
import { PrefetchLink as Link } from '@/components/PrefetchLink';
import { loadStudentWorkspace } from '@/lib/server-context';
import { PrintStudentReport } from './PrintStudentReport';

export const metadata: Metadata = { title: 'تقرير الطالب | Courses' };

export default async function StudentReportPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = await params;
  const context = await loadStudentWorkspace('', studentId);
  if (typeof context === 'string') return <CenterAccessState state={context} />;

  const student = context.students[0];
  const summary = context.summary;
  const branchNames = student.branch_ids.map(id => context.branches.find(branch => branch.id === id)?.name ?? `فرع رقم ${id}`);
  const today = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'long', timeZone: 'Africa/Cairo' }).format(new Date());
  const available = (value: string | null) => value || 'غير مسجل';

  return <CenterPage context={context} path={`/admin/students/${studentId}/report`} className='student-report-page'>
    <CenterPageActions context={context} actions={<PrintStudentReport />} />
    <Link className='student-back-link student-report-screen-only' href={`/admin/students/${student.id}`}>العودة إلى ملف الطالب</Link>
    <article className='context-card student-report' aria-label='تقرير الطالب'>
      <header className='student-report-heading'>
        <div>
          <p className='student-summary-kicker'>{context.center.name} · {today}</p>
          <h2>تقرير الطالب</h2>
          <p>ملخص من البيانات المسجلة ضمن فروع صلاحيتك وقت عرض التقرير.</p>
        </div>
        <div className='student-report-number'>رقم الطالب الداخلي <strong><bdi>{student.student_number.toLocaleString('ar-EG')}</bdi></strong></div>
      </header>
      <section aria-labelledby='student-report-personal'>
        <h3 id='student-report-personal'>البيانات الأساسية</h3>
        <dl className='student-report-facts'>
          <div><dt>اسم الطالب</dt><dd>{student.name}</dd></div>
          <div><dt>حالة الملف</dt><dd>{student.status === 'suspended' ? 'موقوف' : 'نشط'}</dd></div>
          <div><dt>رقم التواصل</dt><dd><bdi dir='ltr'>{available(student.phone)}</bdi></dd></div>
          <div><dt>تاريخ الميلاد</dt><dd>{available(student.date_of_birth)}</dd></div>
          <div><dt>الفروع المرتبطة</dt><dd>{branchNames.join('، ')}</dd></div>
          {student.manual_code !== null ? <div><dt>{context.student_code_settings.label}</dt><dd><bdi dir='ltr'>{student.manual_code}</bdi></dd></div> : null}
        </dl>
      </section>
      <section aria-labelledby='student-report-study'>
        <h3 id='student-report-study'>الدراسة الحالية</h3>
        {summary?.current_study.length ? <>
          <ul className='student-report-study'>{summary.current_study.map(attempt => <li key={attempt.id}>
            <strong>{attempt.course_name} · {attempt.level_name}</strong>
            <span>{attempt.branch_name} · {attempt.group_name ?? 'ينتظر مجموعة للمستوى'}</span>
          </li>)}</ul>
          {summary.current_study_has_more ? <p className='muted'>تظهر أحدث ثلاث محاولات فقط. راجع قسم الدراسة في ملف الطالب لبقية المحاولات.</p> : null}
        </> : <p className='muted'>لا توجد دراسة جارية في الفروع المصرح بها.</p>}
      </section>
      <section aria-labelledby='student-report-attendance'>
        <h3 id='student-report-attendance'>ملخص الغياب الحالي</h3>
        <p>{summary ? `الغيابات المسجلة في المجموعات الحالية: ${summary.current_group_absences.toLocaleString('ar-EG')}.` : 'ملخص الغياب غير متاح.'}</p>
        <p className='muted'>هذا العدد يخص المجموعات الحالية فقط. سجل الحضور والغياب والتعويض التفصيلي موجود في ملف الطالب.</p>
      </section>
      <footer>صدر في {today} · البيانات مرتبطة بصلاحيات المستخدم الحالي.</footer>
    </article>
  </CenterPage>;
}
