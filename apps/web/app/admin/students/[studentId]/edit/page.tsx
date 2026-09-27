import type { Metadata } from 'next';
import type { ComponentProps } from 'react';
import { StudentEditPageData } from './StudentEditPageData';

export const metadata: Metadata = { title: 'تعديل بيانات الطالب | Courses' };

export default function Page(props: ComponentProps<typeof StudentEditPageData>) {
  return <StudentEditPageData {...props} />;
}
