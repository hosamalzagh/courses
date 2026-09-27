import type { Metadata } from 'next';
import { StudentNewPageData } from './StudentNewPageData';

export const metadata: Metadata = { title: 'إنشاء ملف طالب | Courses' };

export default function Page() {
  return <StudentNewPageData />;
}
