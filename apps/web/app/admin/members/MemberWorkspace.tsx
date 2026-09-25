"use client";

import { useState, type FormEvent } from "react";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { centerRequest, responseFieldErrors, responseMessage } from "@/lib/client-api";
import type { Member, MemberContext, Invitation } from "@/lib/server-context";

const branchRoleLabels: Record<string, string> = {
  branch_manager: "مدير الفرع",
  branch_viewer: "عرض الفرع",
  branch_auditor: "تدقيق الفرع",
};

export function MemberWorkspace({ context }: { context: MemberContext }) {
  const [members, setMembers] = useState<Member[]>(context.members);
  const [invitations, setInvitations] = useState<Invitation[]>(context.invitations);
  const [email, setEmail] = useState("");
  const [inviteAsAdmin, setInviteAsAdmin] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [centerRoles, setCenterRoles] = useState<string[]>([]);
  const [branchRoles, setBranchRoles] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; confirmLabel: string; action: () => void } | null>(null);
  const isOwner = context.permissions.center_roles.includes("center_owner");

  async function reload() {
    const response = await centerRequest("member-workspace", "GET");
    if (!response.ok) throw new Error(await responseMessage(response));
    const data: { members: Member[]; invitations: Invitation[] } = await response.json();
    setMembers(data.members);
    setInvitations(data.invitations);
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setFieldErrors({}); setNotice("");
    try {
      const response = await centerRequest("members/invitations", "POST", { email, center_role: inviteAsAdmin ? "center_admin" : null });
      if (!response.ok) {
        setFieldErrors(await responseFieldErrors(response));
        throw new Error(await responseMessage(response));
      }
      setEmail(""); setInviteAsAdmin(false);
      await reload();
      setNotice("أُرسلت الدعوة إلى البريد المحدد.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر إرسال الدعوة."); }
    finally { setBusy(false); }
  }

  async function changeStatus(member: Member) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`members/${member.id}/status`, "PATCH", { status: member.status === "active" ? "suspended" : "active" });
      if (!response.ok) throw new Error(await responseMessage(response));
      await reload(); setNotice("حُدّثت حالة العضوية.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر تحديث العضوية."); }
    finally { setBusy(false); }
  }

  function requestStatusChange(member: Member) {
    if (member.status === "active") {
      setConfirmation({
        title: `إيقاف عضوية ${member.user.name}؟`,
        description: "سيفقد هذا الموظف الوصول من الطلب التالي.",
        confirmLabel: "إيقاف العضوية",
        action: () => void changeStatus(member),
      });
    } else {
      void changeStatus(member);
    }
  }

  function edit(member: Member) {
    setEditing(member.id);
    setCenterRoles([...member.center_roles]);
    setBranchRoles(structuredClone(member.branch_roles));
    setError(""); setNotice("");
  }

  function toggleCenter(role: string) {
    setCenterRoles((previous) => previous.includes(role) ? previous.filter((item) => item !== role) : [...previous, role]);
  }

  function toggleBranch(branchId: number, role: string) {
    const key = String(branchId);
    setBranchRoles((previous) => {
      const roles = previous[key] ?? [];
      return { ...previous, [key]: roles.includes(role) ? roles.filter((item) => item !== role) : [...roles, role] };
    });
  }

  function requestSaveGrants(member: Member) {
    const removesCenterRole = member.center_roles.some((role) => !centerRoles.includes(role));
    const removesBranchRole = Object.entries(member.branch_roles).some(([branchId, roles]) =>
      roles.some((role) => !(branchRoles[branchId] ?? []).includes(role)));
    if (removesCenterRole || removesBranchRole) {
      setConfirmation({
        title: `إزالة صلاحيات ${member.user.name}؟`,
        description: "يسري التغيير من الطلب التالي.",
        confirmLabel: "حفظ التغيير",
        action: () => void saveGrants(member),
      });
    } else {
      void saveGrants(member);
    }
  }

  async function saveGrants(member: Member) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`members/${member.id}/grants`, "PUT", { center_roles: centerRoles, branch_roles: branchRoles });
      if (!response.ok) throw new Error(await responseMessage(response));
      setEditing(null); await reload(); setNotice("حُفظت أدوار الموظف وإسنادات فروعه.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر حفظ الأدوار."); }
    finally { setBusy(false); }
  }

  return <div className="workspace">
    <header className="workspace-header"><div className="workspace-header-inner"><a className="brand" href="/admin"><span className="brand-mark">C</span>Courses</a><span className="muted">{context.center.name} · عضويتك نشطة</span><a className="text-link" href="/admin">العودة إلى الفروع</a></div></header>
    <main className="members-main">
      <div><span className="eyebrow">{context.center.name}</span><h1>موظفو المركز</h1><p className="muted">الدعوات والعضويات وأدوار كل فرع.</p></div>
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      <section className="context-card"><h2>دعوة موظف</h2><form className="member-invite-form" noValidate onSubmit={invite}>
        <FormField id="invite-email" label="البريد الإلكتروني" type="email" value={email} onChange={(value) => { setEmail(value); setFieldErrors({}); }} error={fieldErrors.email} direction="ltr" required />
        {isOwner ? <label className="check-row"><input type="checkbox" checked={inviteAsAdmin} onChange={(event) => setInviteAsAdmin(event.target.checked)} />دعوة بصفة مسؤول مركز</label> : null}
        <button className="button button-primary" disabled={busy || !email}>{busy ? "جارٍ إرسال الدعوة…" : "إرسال الدعوة"}</button>
      </form></section>
      {invitations.length > 0 ? <section><h2 className="section-heading">دعوات بانتظار القبول</h2><div className="member-list">{invitations.map((invitation) => <div className="member-card" key={invitation.id}><bdi dir="ltr">{invitation.email}</bdi><span className="muted">تنتهي {new Date(invitation.expires_at).toLocaleDateString("ar-EG")}</span></div>)}</div></section> : null}
      <section><h2 className="section-heading">العضويات</h2>
        <div className="member-list">{members.map((member) => <article className="member-card" key={member.id}>
          <div className="member-card-head"><div><h3>{member.user.name}</h3><p className="muted"><bdi dir="ltr">{member.user.email}</bdi></p></div><span className="role-pill">{member.status === "active" ? "نشط" : "موقوف"}</span></div>
          <p className="muted">{member.center_roles.includes("center_owner") ? "مالك المركز" : member.center_roles.includes("center_admin") ? "مسؤول المركز" : "موظف المركز"}</p>
          <div className="member-actions"><button className="button button-secondary" type="button" onClick={() => edit(member)} disabled={busy}>تعديل الأدوار</button><button className="button button-secondary" type="button" onClick={() => requestStatusChange(member)} disabled={busy || (member.user.id === context.user.id && member.center_roles.includes("center_owner"))}>{busy ? "جارٍ التحديث…" : member.status === "active" ? "إيقاف العضوية" : "تنشيط العضوية"}</button></div>
          {editing === member.id ? <div className="grant-editor"><h4>أدوار المركز</h4>
            {isOwner ? <label className="check-row"><input type="checkbox" checked={centerRoles.includes("center_owner")} onChange={() => toggleCenter("center_owner")} />مالك المركز</label> : null}
            <label className="check-row"><input type="checkbox" checked={centerRoles.includes("center_admin")} onChange={() => toggleCenter("center_admin")} />مسؤول المركز</label>
            <h4>إسنادات الفروع</h4>{context.branches.map((branch) => <fieldset key={branch.id} className="branch-grant"><legend>{branch.name}</legend>{Object.entries(branchRoleLabels).map(([role, label]) => <label className="check-row" key={role}><input type="checkbox" checked={(branchRoles[String(branch.id)] ?? []).includes(role)} onChange={() => toggleBranch(branch.id, role)} />{label}</label>)}</fieldset>)}
            <div className="member-actions"><button className="button button-primary" type="button" onClick={() => requestSaveGrants(member)} disabled={busy}>{busy ? "جارٍ حفظ الأدوار…" : "حفظ الأدوار"}</button><button className="button button-secondary" type="button" onClick={() => setEditing(null)} disabled={busy}>إلغاء</button></div>
          </div> : null}
        </article>)}</div>
      </section>
    </main>
    {confirmation ? <ConfirmationDialog title={confirmation.title} description={confirmation.description} confirmLabel={confirmation.confirmLabel}
      onCancel={() => setConfirmation(null)} onConfirm={() => { const action = confirmation.action; setConfirmation(null); action(); }} /> : null}
  </div>;
}
