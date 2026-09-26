import Link from 'next/link';

export default function InstructorNotFound() {
  return <main className='state-page'><div><h1>ملف المحاضر غير متاح</h1><p>لا يوجد ملف متاح بهذا الرابط ضمن نطاق صلاحيتك في المركز.</p><Link prefetch={false} href='/admin/instructors'>العودة إلى ملفات المحاضرين</Link></div></main>;
}
