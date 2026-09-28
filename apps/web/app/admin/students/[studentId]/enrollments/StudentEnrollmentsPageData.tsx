import "server-only";
import { CenterAccessState } from "@/components/CenterAccessState";
import { CenterPage } from "@/components/CenterPage";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { loadStudyEnrollments } from "@/lib/server-context";
import { StudentEnrollmentControls } from "./StudentEnrollmentControls";

export async function StudentEnrollmentsPageData({ params, searchParams }: {
  params: Promise<{ studentId: string }>;
  searchParams: Promise<{ page?: string; groups_page?: string; q?: string; attempt_id?: string }>;
}) {
  const { studentId } = await params;
  const { page, groups_page, q, attempt_id } = await searchParams;
  const query = new URLSearchParams({ ...(page ? { page } : {}), ...(groups_page ? { groups_page } : {}), ...(q ? { q } : {}), ...(attempt_id ? { attempt_id } : {}) }).toString();
  const context = await loadStudyEnrollments(studentId, query);
  if (typeof context === "string") return <CenterAccessState state={context} />;

  return <CenterPage context={context} path={`/admin/students/${studentId}/enrollments`}>
    <Link href={`/admin/students/${studentId}`}>العودة إلى ملف الطالب</Link>
    <StudentEnrollmentControls initial={context} search={q ?? ""} linkedAttemptId={attempt_id} />
  </CenterPage>;
}
