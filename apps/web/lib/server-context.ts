import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

export type Branch = { id: number; name: string; slug: string; address: string | null };
export type CenterContext = {
  user: { id: number; name: string; email: string; mfa_enabled?: boolean; mfa_required_for_platform?: boolean };
  membership: { status: string; grants_version: number };
  center: { id: string; name: string; slug: string };
  permissions: {
    center_roles: string[];
    branch_roles: Record<string, string[]>;
    can_manage_center: boolean;
  };
  branches: Branch[];
  settings?: { contact_email: string | null; phone: string | null; address: string | null };
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

export type CenterAccessFailure = "forbidden" | "suspended" | "unavailable";

async function fetchCenterPayload<T>(path: string): Promise<T | CenterAccessFailure> {
  const incoming = await headers();
  const host = incoming.get("host")?.split(":")[0].toLowerCase() ?? "";

  if (!/^[a-z][a-z0-9-]{1,62}\.courses\.test$/.test(host)) notFound();

  let response: Response;
  try {
    response = await fetch(`http://${host}/api/v1/center/${path}`, {
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
  if (response.status === 404) notFound();
  if (response.status === 423 || response.status === 503) return "unavailable";
  if (!response.ok) return "unavailable";

  return response.json() as Promise<T>;
}

export function loadCenterContext(include?: "settings" | "audit"): Promise<CenterContext | CenterAccessFailure> {
  return fetchCenterPayload<CenterContext>(`user${include ? `?include=${include}` : ""}`);
}

export function loadMemberWorkspace(query = ""): Promise<MemberContext | CenterAccessFailure> {
  return fetchCenterPayload<MemberContext>(`member-workspace${query ? `?${query}` : ""}`);
}
