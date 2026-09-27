import { loadStudentCustomFieldWorkspace } from "@/lib/server-context";
import { CenterAccessState } from "@/components/CenterAccessState";
import { CenterPage } from "@/components/CenterPage";
import { StudentCustomFieldControls } from "./StudentCustomFieldControls";
export const metadata = { title: "الحقول الإضافية للطالب | Courses" };
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page } = await searchParams;
  const context = await loadStudentCustomFieldWorkspace(page);
  if (typeof context === "string") return <CenterAccessState state={context} />;
  if (!context.permissions.can_manage_center)
    return <CenterAccessState state="forbidden" />;
  return (
    <CenterPage context={context} path="/admin/student-custom-fields">
      <StudentCustomFieldControls
        key={context.pagination.page}
        context={context}
      />
    </CenterPage>
  );
}
