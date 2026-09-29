import type { ReactNode } from "react";
import type { CenterContext } from "@/lib/server-context";
import { CenterPage } from "@/components/CenterPage";
import { WorkspaceSections } from "@/components/WorkspaceSections";

export function SettingsWorkspace({ context, tab, content }: { context: CenterContext; tab: string; content: ReactNode }) {
  const owner = context.permissions.can_manage_center;
  const studentTab = tab === "students" || tab === "student-fields" || tab === "student-choices";
  const studentSections = [
    { value: "students", label: "إعدادات الطلاب", content: tab === "students" ? content : null },
    { value: "student-fields", label: "الحقول الإضافية", content: tab === "student-fields" ? content : null },
    { value: "student-choices", label: "قوائم بيانات الطالب", content: tab === "student-choices" ? content : null },
  ].map(section => ({ ...section, resetParams: ["page", "kind", "q"] }));
  const sections = [
    ...(owner ? [{ value: "general", label: "عام", content: tab === "general" ? content : null }] : []),
    { value: "branches", label: "الفروع", content: tab === "branches" ? content : null },
    ...(owner ? [{ value: "students", label: "الطلاب", content: studentTab ? <div className="settings-student-sections">
      <WorkspaceSections value={tab} label="أقسام الطلاب" path="/admin/settings" sections={studentSections} appearance="line" />
    </div> : null }] : []),
    { value: "security", label: "أمان الحساب", content: tab === "security" ? content : null },
  ].map(section => ({ ...section, resetParams: ["page", "kind", "q"] }));

  return <CenterPage context={context} path="/admin/settings" className="settings-workspace">
    <WorkspaceSections value={studentTab ? "students" : tab} label="أقسام الإعدادات" path="/admin/settings" sections={sections} appearance="default" />
  </CenterPage>;
}
