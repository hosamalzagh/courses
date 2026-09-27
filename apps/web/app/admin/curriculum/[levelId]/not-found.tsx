import { PrefetchLink as Link } from '@/components/PrefetchLink';

export default function UnavailablePlan() {
  return <main className='auth-main'><section className='auth-card'><h1>خطة المستوى غير متاحة</h1><p>لم نعثر على المستوى ضمن الفروع المصرح لك بها.</p><Link href='/admin/curriculum?tab=levels'>العودة إلى المستويات وخططها</Link></section></main>;
}
