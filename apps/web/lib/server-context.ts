import { cache } from "react";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { CurriculumContext } from "./curriculum";

export type Branch = { id: number; name: string; slug: string; address: string | null };
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
  settings?: { contact_email: string | null; phone: string | null; address: string | null; student_number_start?: number; student_number_revision?: number };
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
export type StudentGeneralData = { date_of_birth: string | null; gender: 'male' | 'female' | null; address: string | null; email: string | null; school: string | null; employer: string | null; specialization: string | null };
export type Student = StudentGeneralData & { age: number | null; created_by: number; created_at: string; id: string; student_number: number; name: string; phone: string | null; revision: number; branch_ids: number[]; can_manage: boolean };
export type StudentContext = CenterContext & { students: Student[]; pagination: { page: number; has_more: boolean; branches_page: number; branches_has_more: boolean } };
export type Instructor = { id: string; name: string; phone: string | null; revision: number; branch_ids: number[]; can_manage: boolean };
export type InstructorContext = CenterContext & { instructors: Instructor[]; pagination: { page: number; has_more: boolean; branches_page: number; branches_has_more: boolean } };
export type StudentSearchPolicy = { enabled: boolean; revision: number };
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
  if (path === "/admin/settings") return loadCenterContext("settings");
  if (path === "/admin/audit") return loadCenterContext("audit");
  if (path === "/admin/members") return loadMemberWorkspace(query(["members_page", "invitations_page", "branches_page"]));
  if (path === "/admin/students") return loadStudentWorkspace(query(["page", "branches_page", "q"]));
  if (path === "/admin/students/new") return loadStudentWorkspace();
  const studentEdit = path.match(/^\/admin\/students\/([^/]+)\/edit$/);
  if (studentEdit) return loadStudentWorkspace("", decodeURIComponent(studentEdit[1]));
  if (path === "/admin/instructors") return loadInstructorWorkspace(query(["page", "branches_page", "q"]));
  if (path === "/admin/curriculum") return loadCurriculumWorkspace(query(["courses_page", "stages_page", "levels_page", "branches_page"]));
  if (path === "/admin/student-search") return loadStudentSearchWorkspace(query(["q", "page"]));
  const detail = path.match(/^\/admin\/(students|instructors|curriculum)\/([^/]+)$/);
  if (detail) {
    const id = decodeURIComponent(detail[2]);
    if (detail[1] === "students") return loadStudentWorkspace("", id);
    if (detail[1] === "instructors") return loadInstructorWorkspace("", id);
    return loadCurriculumWorkspace("", id);
  }
  notFound();
}
