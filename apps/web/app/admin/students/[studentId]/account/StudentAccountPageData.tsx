import "server-only";
import { CenterAccessState } from "@/components/CenterAccessState";
import { CenterPage } from "@/components/CenterPage";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { loadStudentAccount } from "@/lib/server-context";
import { StudentFinanceControls } from "./StudentFinanceControls";

export async function StudentAccountPageData({ params, searchParams }: {
  params: Promise<{ studentId: string }>;
  searchParams: Promise<{ page?: string; branches_page?: string; q?: string }>;
}) {
  const { studentId } = await params;
  const { page, branches_page, q } = await searchParams;
  const query = new URLSearchParams({ ...(page ? { page } : {}), ...(branches_page ? { branches_page } : {}), ...(q ? { q } : {}) }).toString();
  const context = await loadStudentAccount(studentId, query);
  if (typeof context === "string") return <CenterAccessState state={context} />;

  return <CenterPage context={context} path={`/admin/students/${studentId}/account`}>
    <Link href={`/admin/students/${studentId}`}>العودة إلى ملف الطالب</Link>
    <StudentFinanceControls initial={context} search={q ?? ""} />
  </CenterPage>;
}
