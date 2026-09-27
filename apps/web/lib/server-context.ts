import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { CurriculumContext } from "./curriculum";

export type Branch = { id: number; name: string; slug: string; address: string | null };
export type CenterSettings = { contact_email: string | null; phone: string | null; address: string | null; student_number_start?: number; student_number_revision?: number; student_code_enabled?: boolean; student_code_label?: string; student_code_revision?: number };
export type CenterContext = {
  user: { id: number; name: string; email: string; mfa_enabled?: boolean; mfa_required_for_platform?: boolean };
  membership: { status: string; grants_version: number };
  center: { id: string; name: string; slug: string };
  permissions: {
    center_roles: string[];
    branch_roles: Record<string, string[]>;
    branch_actions?: Record<string, string[]>;
    can_manage_center: boolean;
  };
  branches: Branch[];
  settings?: CenterSettings;
  audit_entries?: AuditEntry[];
};

export type AuditEntry = { id: number; actor_id: number | null; branch_id: number | null; event: string; details: unknown; created_at: string };

export type GrantOption = { label: string; description: string; actions: string[]; additional?: boolean; owner_only?: boolean };
export type WorkspacePagination = Record<"members" | "invitations" | "branches", { page: number; has_more: boolean }>;

export type Member = {
  id: number;
  user: { id: number; name: string; email: string };
  status: "active" | "suspended";
  grant_revision: string;
  center_roles: string[];
  branch_roles: Record<string, string[]>;
};
export type Invitation = { id: number; email: string; center_role: string | null; expires_at: string; status: "pending" | "expired" | "uncertain" | "not_sent" };
export type MemberContext = CenterContext & { members: Member[]; invitations: Invitation[]; grant_options: Record<string, GrantOption>; pagination: WorkspacePagination };
export type StudentCustomField = {id:string;label:string;type:'text'|'number'|'date'|'select'|'boolean';required:boolean;position:number;options:string[];revision:number;active:boolean;classification:'general'|'identity';disabled_options:string[];used:boolean};
export type StudentCustomValues = Record<string, string | boolean | null>;
export type StudentCustomFieldList = {fields:StudentCustomField[];revision:number;page:number;has_more:boolean};
export type StudentCustomFieldContext = CenterContext & {fields:StudentCustomField[];values:StudentCustomValues;revision:number;pagination:{page:number;has_more:boolean}};
export type StudentCustomHistoryEntry = {id:number;field_id:string;profile_revision:number;label:string;type:StudentCustomField['type'];value:string|boolean|null;actor_id:number|null;actor_name:string|null;imported:boolean;created_at:string;active:boolean};
export type StudentCustomHistory = {entries:StudentCustomHistoryEntry[];pagination:{page:number;has_more:boolean}};
export type StudentChoiceKind = 'city' | 'qualification' | 'profession' | 'collection_method' | 'discovery_source';
export type StudentProfileChoice = { id: string; kind: StudentChoiceKind; label: string; position: number; active: boolean; revision: number };
export type StudentChoiceList = { choices: StudentProfileChoice[]; page: number; has_more: boolean };
export type StudentChoiceContext = CenterContext & { choices: StudentProfileChoice[]; pagination: { page: number; has_more: boolean } };
export type StudentGeneralData = Record<`${StudentChoiceKind}_id`, string | null> & { date_of_birth: string | null; gender: 'male' | 'female' | null; address: string | null; email: string | null; school: string | null; employer: string | null; specialization: string | null };
export type StudentChannelKind = 'primary' | 'alternative' | 'whatsapp' | 'sinjapp';
export type StudentContact = { id: string; name: string; relationship: string; phone: string; primary: boolean };
export type StudentContactsData = { contacts: StudentContact[]; channels: Record<StudentChannelKind, { contact_id: string; phone: string } | null> };
export type StudentIdentityData = { national_id: string | null; passport_number: string | null };
export type StudentPhoto = { id:string; preview:string; url:string };
export type Student = { photo: StudentPhoto | null; photo_revision:number;custom_values?:StudentCustomValues;missing_custom_fields:number; identity?: StudentIdentityData; can_read_identity: boolean; can_manage_identity: boolean } & StudentGeneralData & StudentContactsData & { legacy_phone: string | null; manual_code: string | null } & { profile_choices: Partial<Record<StudentChoiceKind, StudentProfileChoice>>; age: number | null; created_by: number; created_at: string; id: string; student_number: number; name: string; phone: string | null; revision: number; branch_ids: number[]; can_manage: boolean; sharing_enabled: boolean; status: 'active' | 'suspended'; status_revision: number; can_change_status: boolean };
export type StudentSuspension = { id: string; suspended_by: number; suspended_by_name: string; suspended_reason: string; suspended_at: string; lifted_by: number | null; lifted_by_name: string | null; lifted_reason: string | null; lifted_at: string | null };
export type StudentContext = CenterContext & {custom_history?:StudentCustomHistory;custom_fields:StudentCustomFieldList; student_code_settings: {enabled:boolean;label:string;revision:number}; profile_choice_lists: Record<StudentChoiceKind, StudentChoiceList>; students: Student[]; suspensions?: StudentSuspension[]; status_pagination?: { page: number; has_more: boolean }; pagination: { page: number; has_more: boolean; branches_page: number; branches_has_more: boolean } };
export type Instructor = { id: string; name: string; phone: string | null; revision: number; branch_ids: number[]; can_manage: boolean };
export type InstructorContext = CenterContext & { instructors: Instructor[]; pagination: { page: number; has_more: boolean; branches_page: number; branches_has_more: boolean } };
export type StudentSearchPolicy = { enabled: boolean; revision: number; default_sharing_enabled: boolean };
export type StudentSearchResult = { id: string; student_number: number; name: string; phone: string | null; within_scope: boolean };
export type StudentSearchContext = CenterContext & { policy: StudentSearchPolicy; students: StudentSearchResult[]; pagination: { page: number; has_more: boolean }; can_search: boolean };

export type CenterAccessFailure = "forbidden" | "suspended" | "unavailable" | "student_unavailable";

const fetchCenterPayload = cache(async function fetchCenterPayload<T>(path: string): Promise<T | CenterAccessFailure> {
  const incoming = await headers();
  const host = incoming.get("host")?.split(":")[0].toLowerCase() ?? "";

  if (!/^[a-z][a-z0-9-]{1,62}\.courses\.test$/.test(host)) notFound();

  let response: Response;
  try {
    response = await fetch(`${process.env.COURSES_INTERNAL_API_ORIGIN?.replace('{host}', host) ?? `http://${host}${process.env.COURSES_API_PORT ? `:${process.env.COURSES_API_PORT}` : ""}`}/api/v1/center/${path}`, {
      headers: {
        Cookie: incoming.get("cookie") ?? "",
        Accept: "application/json",
      },
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    return "unavailable";
  }

  if (response.status === 401) {
    const hadSession = /(?:^|;\s*)[A-Za-z0-9_-]*session=/i.test(incoming.get("cookie") ?? "");
    redirect(hadSession ? "/login?expired=1" : "/login");
  }
  if (response.status === 403) {
    const data = await response.json().catch(() => ({}));
    return data.code === "membership_suspended" ? "suspended" : "forbidden";
  }
  if (response.status === 404) {
    if (path.startsWith('students/')) return 'student_unavailable';
    notFound();
  }
  if (response.status === 423 || response.status === 503) return "unavailable";
  if (!response.ok) return "unavailable";

  return response.json() as Promise<T>;
});

export function loadCenterContext(include?: "settings" | "audit"): Promise<CenterContext | CenterAccessFailure> {
  return fetchCenterPayload<CenterContext>(`user${include ? `?include=${include}` : ""}`);
}

export function loadMemberWorkspace(query = ""): Promise<MemberContext | CenterAccessFailure> {
  return fetchCenterPayload<MemberContext>(`member-workspace${query ? `?${query}` : ""}`);
}

export function loadStudentCustomFieldWorkspace(page = "1"): Promise<StudentCustomFieldContext | CenterAccessFailure> {
  return fetchCenterPayload<StudentCustomFieldContext>(`student-custom-fields?${new URLSearchParams({page, manage:"1"})}`);
}

export function loadStudentChoiceWorkspace(kind = "city", page = "1", q = ""): Promise<StudentChoiceContext | CenterAccessFailure> {
  return fetchCenterPayload<StudentChoiceContext>(`student-profile-choices?${new URLSearchParams({ kind, page, q, manage: "1" })}`);
}

export function loadStudentWorkspace(query = "", studentId?: string): Promise<StudentContext | CenterAccessFailure> {
  return fetchCenterPayload<StudentContext>(`${studentId ? `students/${encodeURIComponent(studentId)}` : "student-workspace"}${query ? `?${query}` : ""}`);
}

export function loadInstructorWorkspace(query = "", instructorId?: string): Promise<InstructorContext | CenterAccessFailure> {
  return fetchCenterPayload<InstructorContext>(`${instructorId ? `instructors/${encodeURIComponent(instructorId)}` : "instructor-workspace"}${query ? `?${query}` : ""}`);
}

export function loadStudentSearchWorkspace(query = ""): Promise<StudentSearchContext | CenterAccessFailure> {
  return fetchCenterPayload<StudentSearchContext>(`student-search-workspace${query ? `?${query}` : ""}`);
}

export function loadCurriculumWorkspace(query = "", levelId?: string): Promise<CurriculumContext | CenterAccessFailure> {
  return fetchCenterPayload<CurriculumContext>(`${levelId ? `levels/${encodeURIComponent(levelId)}` : "curriculum-workspace"}${query ? `?${query}` : ""}`);
}

// Proxy supplies the actual URL so the layout shares the page's authorized payload.
// React cache deduplicates only within this server render, never between users/centers.
export async function loadAdminLayoutContext(): Promise<CenterContext | CenterAccessFailure> {
  const incoming = await headers();
  const url = new URL(incoming.get("x-courses-admin-url") ?? "/admin", "http://courses.test");
  const path = url.pathname;
  function query(keys: string[]) {
    const result = new URLSearchParams();
    for (const key of keys) {
      const values = url.searchParams.getAll(key);
      if (values.length === 1) result.set(key, values[0]);
    }
    return result.toString();
  }
  if (path === "/admin" || path === "/admin/security") return loadCenterContext();
  if (path === "/admin/student-custom-fields") return loadStudentCustomFieldWorkspace(url.searchParams.get("page") ?? "1");
  if (path === "/admin/student-profile-choices") return loadStudentChoiceWorkspace(url.searchParams.get("kind") ?? "city", url.searchParams.get("page") ?? "1", url.searchParams.get("q") ?? "");
  if (path === "/admin/settings") return loadCenterContext("settings");
  if (path === "/admin/audit") return loadCenterContext("audit");
  if (path === "/admin/members") return loadMemberWorkspace(query(["members_page", "invitations_page", "branches_page"]));
  if (path === "/admin/students") return loadStudentWorkspace(query(["page", "branches_page", "q", "identifier"]));
  if (path === "/admin/students/new") return loadStudentWorkspace();
  const studentEdit = path.match(/^\/admin\/students\/([^/]+)\/edit$/);
  if (studentEdit) return loadStudentWorkspace("", decodeURIComponent(studentEdit[1]));
  if (path === "/admin/instructors") return loadInstructorWorkspace(query(["page", "branches_page", "q", "identifier"]));
  if (path === "/admin/curriculum") return loadCurriculumWorkspace(query(["courses_page", "stages_page", "levels_page", "branches_page"]));
  if (path === "/admin/student-search") {
    const params = new URLSearchParams(query(["q", "page"]));
    if (url.searchParams.get("tab") === "settings") params.set("view", "settings");
    return loadStudentSearchWorkspace(params.toString());
  }
  const detail = path.match(/^\/admin\/(students|instructors|curriculum)\/([^/]+)$/);
  if (detail) {
    const id = decodeURIComponent(detail[2]);
    if (detail[1] === "students") return loadStudentWorkspace(query(["status_page", "tab", "custom_history_page"]), id);
    if (detail[1] === "instructors") return loadInstructorWorkspace("", id);
    return loadCurriculumWorkspace("", id);
  }
  notFound();
}
