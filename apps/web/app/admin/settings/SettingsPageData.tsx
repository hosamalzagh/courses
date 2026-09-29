import "server-only";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { loadCenterContext, loadStudentChoiceWorkspace, loadStudentCustomFieldWorkspace, type StudentChoiceContext, type StudentCustomFieldContext } from "@/lib/server-context";
import { CenterAccessState } from "@/components/CenterAccessState";
import { BranchControls } from "../BranchControls";
import { SecurityControls } from "../security/SecurityControls";
import { StudentCustomFieldControls } from "../student-custom-fields/StudentCustomFieldControls";
import { StudentChoiceControls } from "../student-profile-choices/StudentChoiceControls";
import { SettingsWorkspace } from "./SettingsWorkspace";
import { SettingsControls } from "./SettingsControls";
import { StudentSettingsControls } from "./StudentSettingsControls";
import { CurrencyControls } from "./CurrencyControls";
import { SettingsRow } from "@/components/SettingsRow";

const tabs = ["general", "branches", "students", "student-fields", "student-choices", "security"] as const;
type SettingsTab = (typeof tabs)[number];

export async function SettingsPageData({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const requested = typeof params.tab === "string" ? params.tab : null;
  if (requested !== null && !tabs.some(tab => tab === requested)) notFound();
  const tab = requested as SettingsTab | null;
  const listPage = typeof params.page === "string" ? params.page : "1";
  const choiceKind = typeof params.kind === "string" ? params.kind : "city";
  const choiceQuery = typeof params.q === "string" ? params.q : "";

  const context = tab === "student-fields"
    ? await loadStudentCustomFieldWorkspace(listPage)
    : tab === "student-choices"
      ? await loadStudentChoiceWorkspace(choiceKind, listPage, choiceQuery)
      : await loadCenterContext(tab === "students" ? "student-settings" : tab === "general" || tab === null ? "settings" : undefined);
  if (typeof context === "string") return <CenterAccessState state={context} />;
  const selected = tab ?? (context.permissions.can_manage_center ? "general" : "branches");
  if (selected !== "branches" && selected !== "security" && !context.permissions.can_manage_center) notFound();

  let content: ReactNode;
  switch (selected) {
    case "general":
      content = <><SettingsControls context={context} initialSettings={context.settings!} /><CurrencyControls settings={context.settings!} /></>;
      break;
    case "branches":
      content = <BranchControls context={context} />;
      break;
    case "students":
      content = <StudentSettingsControls settings={context.settings!} policy={context.student_search_policy!} />;
      break;
    case "student-fields":
      content = <StudentCustomFieldControls context={context as StudentCustomFieldContext} />;
      break;
    case "student-choices":
      content = <StudentChoiceControls context={context as StudentChoiceContext} kind={choiceKind} query={choiceQuery} />;
      break;
    case "security":
      content = <div className="settings-list"><SettingsRow title="التحقق بخطوتين" description="حماية حسابك عند الدخول إلى أي مركز. إعداد المصادقة ورموز الاستعادة تخص حسابك الشخصي."><SecurityControls context={context} initialEnabled={context.user.mfa_enabled ?? false} requiredForPlatform={context.user.mfa_required_for_platform ?? false} /></SettingsRow></div>;
      break;
  }
  return <SettingsWorkspace context={context} tab={selected} content={content} />;
}
