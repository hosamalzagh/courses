import "server-only";
import { CenterAccessState } from "@/components/CenterAccessState";
import { CenterPage } from "@/components/CenterPage";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { loadCourseCompletion } from "@/lib/server-context";
import { CourseCompletionTable } from "./CourseCompletionTable";

export async function CourseCompletionPageData({ params, searchParams }: {
  params: Promise<{ studentId: string; courseId: string }>;
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  const { studentId, courseId } = await params;
  const { page, q } = await searchParams;
  const query = new URLSearchParams({ ...(page ? { page } : {}), ...(q ? { q } : {}) }).toString();
  const context = await loadCourseCompletion(studentId, courseId, query);
  if (typeof context === "string") return <CenterAccessState state={context} />;

  return <CenterPage context={context} path={`/admin/students/${studentId}/courses/${courseId}/completion`}>
    <div className="form-stack">
      <Link href={`/admin/students/${studentId}`}>العودة إلى ملف الطالب</Link>
      <CourseCompletionTable context={context} search={q ?? ""} />
    </div>
  </CenterPage>;
}
