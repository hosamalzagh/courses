import Link from 'next/link';

export default function StudentNotFound() {
  return <main className='state-page'><div><h1>ملف الطالب غير متاح</h1><p>لا يوجد ملف متاح بهذا الرابط ضمن نطاق صلاحيتك في المركز.</p><Link prefetch={false} href='/admin/students'>العودة إلى ملفات الطلاب</Link></div></main>;
}
