import Link from 'next/link';

export default function UnavailablePlan() {
  return <main className='auth-main'><section className='auth-card'><h1>خطة المستوى غير متاحة</h1><p>لم نعثر على المستوى ضمن الفروع المصرح لك بها.</p><Link prefetch={false} href='/admin/curriculum'>العودة إلى منهج الفرع</Link></section></main>;
}
