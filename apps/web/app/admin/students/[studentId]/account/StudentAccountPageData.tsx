import "server-only";
import { CenterAccessState } from "@/components/CenterAccessState";
import { CenterPage } from "@/components/CenterPage";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { loadStudentAccount } from "@/lib/server-context";
import { StudentFinanceControls } from "./StudentFinanceControls";

export async function StudentAccountPageData({ params, searchParams }: {
  params: Promise<{ studentId: string }>;
  searchParams: Promise<{ page?: string; branches_page?: string; fees_page?: string; events_page?: string; q?: string; payment_id?: string; allocation_id?: string; financial_event_type?: string; financial_event_id?: string }>;
}) {
  const { studentId } = await params;
  const { page, branches_page, fees_page, events_page, q, payment_id, allocation_id, financial_event_type, financial_event_id } = await searchParams;
  const query = new URLSearchParams({ ...(page ? { page } : {}), ...(branches_page ? { branches_page } : {}),
    ...(fees_page ? { fees_page } : {}), ...(events_page ? { events_page } : {}), ...(q ? { q } : {}),
    ...(payment_id ? { payment_id } : {}), ...(financial_event_type ? { financial_event_type } : {}),
    ...(financial_event_id ? { financial_event_id } : {}) }).toString();
  const context = await loadStudentAccount(studentId, query);
  if (typeof context === "string") return <CenterAccessState state={context} />;

  return <CenterPage context={context} path={`/admin/students/${studentId}/account`}>
    <Link href={`/admin/students/${studentId}`}>العودة إلى ملف الطالب</Link>
    <StudentFinanceControls initial={context} search={q ?? ""} paymentId={payment_id} allocationId={allocation_id}
      financialEventType={financial_event_type} financialEventId={financial_event_id} />
  </CenterPage>;
}
