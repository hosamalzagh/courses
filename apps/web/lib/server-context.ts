import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";

export type Branch = { id: number; name: string; slug: string; address: string | null };
export type CenterContext = {
  user: { id: number; name: string; email: string };
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

export type Member = {
  id: number;
  user: { id: number; name: string; email: string };
  status: "active" | "suspended";
  center_roles: string[];
  branch_roles: Record<string, string[]>;
};
export type Invitation = { id: number; email: string; center_role: string | null; expires_at: string };
export type MemberContext = CenterContext & { members: Member[]; invitations: Invitation[] };

async function fetchCenterPayload<T>(path: string): Promise<T | "forbidden" | "unavailable"> {
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

  if (response.status === 401) redirect("/login");
  if (response.status === 403) return "forbidden";
  if (response.status === 404) notFound();
  if (response.status === 423 || response.status === 503) return "unavailable";
  if (!response.ok) return "unavailable";

  return response.json() as Promise<T>;
}

export function loadCenterContext(include?: "settings" | "audit"): Promise<CenterContext | "forbidden" | "unavailable"> {
  return fetchCenterPayload<CenterContext>(`user${include ? `?include=${include}` : ""}`);
}

export function loadMemberWorkspace(): Promise<MemberContext | "forbidden" | "unavailable"> {
  return fetchCenterPayload<MemberContext>("member-workspace");
}
