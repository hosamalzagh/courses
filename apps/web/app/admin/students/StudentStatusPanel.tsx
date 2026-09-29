import { PrefetchLink as Link } from '@/components/PrefetchLink';
import type { StudentContext } from '@/lib/server-context';
import { StudentStatusControls } from './StudentStatusControls';

export function StudentStatusPanel({ context, tab }: { context: StudentContext; tab?: string }) {
  const student = context.students[0];
  if (!student) return null;
  const date = (value: string) => new Date(value).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' });
  const pagination = context.status_pagination;
  const statusHref = (page: number) => `/admin/students/${student.id}?${tab ? `tab=${encodeURIComponent(tab)}&` : ''}status_page=${page}`;
  return <section className='context-card form-stack' aria-labelledby='student-status-title'>
    <h2 id='student-status-title'>حالة ملف الطالب: {student.status === 'active' ? 'نشط' : 'موقوف'}</h2>
    {student.can_change_status ? <StudentStatusControls student={student} /> : <p className='muted'>تغيير الحالة متاح لمالك المركز ومسؤول المركز فقط.</p>}
    <h3>فترات الإيقاف</h3>
    <p className='muted'>الأوقات بتوقيت القاهرة.</p>
    {context.suspensions?.length ? <ol className='form-stack'>{context.suspensions.map((period) => <li key={period.id}>
      <p>الإيقاف: <time dateTime={period.suspended_at}>{date(period.suspended_at)}</time> — {period.suspended_by_name} · رقم الموظف {period.suspended_by.toLocaleString('ar-EG')}</p>
      <p>السبب: {period.suspended_reason}</p>
      {period.lifted_at ? <><p>فك الإيقاف: <time dateTime={period.lifted_at}>{date(period.lifted_at)}</time> — {period.lifted_by_name} · رقم الموظف {period.lifted_by?.toLocaleString('ar-EG')}</p><p>السبب: {period.lifted_reason}</p></> : <p>الإيقاف مستمر</p>}
    </li>)}</ol> : <p>لا توجد فترات إيقاف مسجلة.</p>}
    {pagination && (pagination.page > 1 || pagination.has_more) ? <nav className='form-actions' aria-label='صفحات فترات الإيقاف'>
      {pagination.page > 1 ? <Link href={statusHref(pagination.page - 1)}>الفترات الأحدث</Link> : null}
      <span>صفحة {pagination.page.toLocaleString('ar-EG')}</span>
      {pagination.has_more ? <Link href={statusHref(pagination.page + 1)}>الفترات الأقدم</Link> : null}
    </nav> : null}
  </section>;
}
