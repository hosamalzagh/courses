import { PrefetchLink as Link } from '@/components/PrefetchLink';

export default function StudentNotFound() {
  return <main className='state-page'><div><h1>ملف الطالب غير متاح</h1><p>لا يوجد ملف متاح بهذا الرابط ضمن نطاق صلاحيتك في المركز.</p><Link href='/admin/students'>العودة إلى ملفات الطلاب</Link></div></main>;
}
