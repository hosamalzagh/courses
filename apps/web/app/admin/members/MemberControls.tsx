"use client";

import { useId } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";


import { useState, useEffect, useRef, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CenterPageActions, CenterHeaderActions } from "@/components/CenterShell";
import { DataTable } from "@/components/DataTable";
import { Button } from "@/components/Button";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { ConfirmationDialog } from "@/components/ConfirmationDialog";
import { centerRequest, responseFieldErrors, responseMessage } from "@/lib/client-api";
import type { Member, MemberContext, Invitation } from "@/lib/server-context";

const invitationLabels: Record<Invitation["status"], string> = {
  pending: "بانتظار القبول",
  expired: "انتهت صلاحية الدعوة",
  uncertain: "التسليم غير مؤكد",
  not_sent: "لم تُرسل الدعوة",
};

export function MemberControls({ context }: { context: MemberContext }) {
  const formPrefix = useId();
  const router = useRouter();
  const [workspace, setWorkspace] = useState(context);
  const editTrigger = useRef<HTMLButtonElement | null>(null);
  const editor = useRef<HTMLDivElement | null>(null);
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
  const isOwner = workspace.permissions.center_roles.includes("center_owner");

  useEffect(() => {
    if (editing !== null) editor.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();
    else editTrigger.current?.focus();
  }, [editing]);

  async function reload(query = new URLSearchParams(window.location.search)) {
    const response = await centerRequest(`member-workspace?${query}`, "GET");
    if (!response.ok) throw new Error(await responseMessage(response));
    const data: MemberContext = await response.json();
    setWorkspace(data);
    setMembers(data.members);
    setInvitations(data.invitations);
    router.refresh();
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setFieldErrors({}); setNotice("");
    try {
      const response = await centerRequest("members/invitations", "POST", { email, center_role: inviteAsAdmin ? "center_admin" : null });
      if (!response.ok) {
        setFieldErrors(await responseFieldErrors(response));
        const message = await responseMessage(response);
        if (response.status === 409) await reload();
        throw new Error(message);
      }
      const result: { status: "sent" | "already_sent" | "role_updated" } = await response.json();
      setEmail(""); setInviteAsAdmin(false);
      await reload();
      setNotice(result.status === "already_sent"
        ? "الدعوة السابقة ما زالت صالحة، ولم تُرسل رسالة جديدة."
        : result.status === "role_updated"
          ? "حُدّث دور الدعوة السابقة، ولم تُرسل رسالة جديدة."
          : "أُرسلت الدعوة إلى البريد المحدد.");
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

  function edit(member: Member, trigger: HTMLButtonElement) {
    editTrigger.current = trigger;
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
    const removesRole = member.center_roles.some((role) => !centerRoles.includes(role))
      || Object.entries(member.branch_roles).some(([branchId, roles]) => roles.some((role) => !(branchRoles[branchId] ?? []).includes(role)));
    const addsOperationalGrant = Object.entries(branchRoles).some(([branchId, roles]) => roles.some((role) =>
      !role.startsWith("branch_") && !(member.branch_roles[branchId] ?? []).includes(role)));
    if (!removesRole && !addsOperationalGrant) { void saveGrants(member); return; }
    setConfirmation({
      title: `حفظ صلاحيات ${member.user.name}؟`,
      description: "تُحفظ الأدوار والصلاحيات الإضافية للفروع المعروضة فقط، ويسري التغيير من الطلب التالي.",
      confirmLabel: "حفظ التغيير",
      action: () => void saveGrants(member),
    });
  }

  function requestPageChange(section: "members" | "invitations" | "branches", page: number) {
    if (editing !== null) {
      setConfirmation({ title: "ترك تعديل الأدوار؟", description: "ستُفقد اختياراتك غير المحفوظة عند تغيير الدفعة.", confirmLabel: "ترك التعديل", action: () => void changePage(section, page) });
    } else { void changePage(section, page); }
  }

  async function changePage(section: "members" | "invitations" | "branches", page: number) {
    setBusy(true); setError("");
    try {
      const query = new URLSearchParams(window.location.search);
      query.set(`${section}_page`, String(page));
      await reload(query);
      window.history.replaceState(null, "", `?${query}`);
      setEditing(null);
    } catch { setError("تعذر تحميل الصفحة. حاول مرة أخرى."); }
    finally { setBusy(false); }
  }

  function pagination(section: "members" | "invitations" | "branches") {
    const state = workspace.pagination[section];
    return <nav className="form-actions" aria-label={`صفحات ${section === "members" ? "الموظفين" : section === "invitations" ? "الدعوات" : "الفروع"}`}>
      <Button disabled={busy || state.page === 1} onClick={() => requestPageChange(section, state.page - 1)}>الدفعة السابقة</Button>
      <span>دفعة {state.page} · حتى ٥٠ سجلًا؛ البحث داخل الدفعة المعروضة</span>
      <Button disabled={busy || !state.has_more} onClick={() => requestPageChange(section, state.page + 1)}>الدفعة التالية</Button>
    </nav>;
  }

  async function saveGrants(member: Member) {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await centerRequest(`members/${member.id}/grants`, "PUT", { center_roles: centerRoles, branch_roles: branchRoles, grant_revision: member.grant_revision, branch_scope: workspace.branches.map((branch) => branch.id) });
      if (!response.ok) {
        if (response.status === 409 && (await response.clone().json().catch(() => ({}))).code === "grants_changed") {
          await reload(); setEditing(null);
          throw new Error("تغيّرت صلاحيات الموظف منذ فتح التعديل. أعد فتح الأدوار وراجع القيم الحالية قبل الحفظ.");
        }
        throw new Error(await responseMessage(response));
      }
      setEditing(null); await reload(); setNotice("حُفظت أدوار الموظف وإسنادات فروعه.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "تعذر حفظ الأدوار."); }
    finally { setBusy(false); }
  }

  return <>
    <CenterPageActions context={workspace} actions={editing ? null : <Button variant="primary" form={`${formPrefix}-0`} disabled={busy || !email} type="submit" busy={busy} busyLabel="جارٍ إرسال الدعوة…">إرسال الدعوة</Button>} />


      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      <section className="context-card"><h2>دعوة موظف</h2><form id={`${formPrefix}-0`} className="member-invite-form" noValidate onSubmit={invite}>
<FieldGroup>
        <FormField id="invite-email" label="البريد الإلكتروني" type="email" value={email} onChange={(value) => { setEmail(value); setFieldErrors({}); }} error={fieldErrors.email} direction="ltr" required />
        {isOwner ? <FieldLabel className="flex items-center gap-2"><Checkbox disabled={busy} checked={inviteAsAdmin} onCheckedChange={(checked) => setInviteAsAdmin(checked)} />دعوة بصفة مسؤول مركز</FieldLabel> : null}

      </FieldGroup>
</form></section>
      <DataTable id="invitations" title="الدعوات" rows={invitations} rowKey={(invitation) => invitation.id} searchText={(invitation) => invitation.email} emptyMessage="لا توجد دعوات حاليًا."
        filters={Object.entries(invitationLabels).map(([value, label]) => ({ value, label, matches: (invitation: Invitation) => invitation.status === value }))}
        columns={[
          { key: "email", label: "البريد الإلكتروني", filterText: (invitation) => invitation.email, render: (invitation) => <bdi dir="ltr">{invitation.email}</bdi> },
          { key: "status", label: "الحالة", render: (invitation) => <span className={`role-pill ${invitation.status === "pending" ? "" : "status-warning"}`}>{invitationLabels[invitation.status]}</span> },
          { key: "expires", label: "صلاحية الدعوة", filterText: (invitation) => new Date(invitation.expires_at).toLocaleDateString("ar-EG", { timeZone: "Africa/Cairo" }), render: (invitation) => <span className="muted">{invitation.status === "expired" ? "انتهت" : "تنتهي"} {new Date(invitation.expires_at).toLocaleDateString("ar-EG", { timeZone: "Africa/Cairo" })}</span> },
          { key: "note", label: "ملاحظات", render: (invitation) => <span className="muted">{invitation.status === "uncertain" ? "تحقق من تسليم البريد مع دعم المنصة قبل إعادة الدعوة." : invitation.status === "not_sent" ? "يمكنك إعادة إرسال الدعوة من النموذج أعلاه." : "—"}</span> },
        ]}
      />
      {pagination("invitations")}
      <DataTable id="members" title="العضويات" rows={members} rowKey={(member) => member.id} searchText={(member) => `${member.user.name} ${member.user.email}`} emptyMessage="لا توجد عضويات متاحة."
        filters={[{ value: "active", label: "نشط", matches: (member) => member.status === "active" }, { value: "suspended", label: "موقوف", matches: (member) => member.status === "suspended" }]}
        columns={[
          { key: "user", label: "الموظف", filterText: (member) => `${member.user.name} ${member.user.email}`, render: (member) => <><h3>{member.user.name}</h3><p className="muted"><bdi dir="ltr">{member.user.email}</bdi></p></> },
          { key: "role", label: "دور المركز", filterText: (member) => member.center_roles.includes("center_owner") ? "مالك المركز" : member.center_roles.includes("center_admin") ? "مسؤول المركز" : "موظف المركز", render: (member) => <span>{member.center_roles.includes("center_owner") ? "مالك المركز" : member.center_roles.includes("center_admin") ? "مسؤول المركز" : "موظف المركز"}</span> },
          { key: "status", label: "الحالة", render: (member) => <span className={`role-pill ${member.status === "active" ? "" : "status-warning"}`}>{member.status === "active" ? "نشط" : "موقوف"}</span> },
          { key: "actions", label: "الإجراءات", actions: true, render: (member) => <div className="row-actions">{isOwner || !member.center_roles.includes("center_owner") ? <Button onClick={(event) => edit(member, event.currentTarget)} disabled={busy}>تعديل الأدوار</Button> : null}<Button variant={member.status === "active" ? "danger" : "secondary"} onClick={() => requestStatusChange(member)} disabled={busy || (member.user.id === context.user.id && member.center_roles.includes("center_owner"))}>{member.status === "active" ? "إيقاف العضوية" : "تنشيط العضوية"}</Button></div> },
        ]}
        expanded={(member) => editing === member.id ? <div ref={editor} className="grant-editor" role="region" aria-label={`أدوار ${member.user.name}`}><FieldSet disabled={busy}><FieldLegend>أدوار المركز</FieldLegend>
            {isOwner ? <FieldLabel className="flex items-center gap-2"><Checkbox disabled={busy} checked={centerRoles.includes("center_owner")} onCheckedChange={() => toggleCenter("center_owner")} />مالك المركز</FieldLabel> : null}
            {isOwner ? <FieldLabel className="flex items-center gap-2"><Checkbox disabled={busy} checked={centerRoles.includes("center_admin")} onCheckedChange={() => toggleCenter("center_admin")} />مسؤول المركز</FieldLabel> : null}
            <h4>إسنادات الفروع</h4>{workspace.branches.map((branch) => <FieldSet key={branch.id} ><FieldLegend>{branch.name}</FieldLegend>
              {[false, true].map((additional) => <div key={String(additional)}><h5>{additional ? "صلاحيات إضافية مستقلة" : "أدوار التشغيل"}</h5>
                {Object.entries(workspace.grant_options).filter(([, option]) => Boolean(option.additional) === additional).map(([role, option]) => <FieldLabel className="flex items-center gap-2" key={role}>
                  <Checkbox  disabled={busy || Boolean(option.owner_only && !isOwner)} checked={(branchRoles[String(branch.id)] ?? []).includes(role)} onCheckedChange={() => toggleBranch(branch.id, role)} />{option.label}
                </FieldLabel>)}
              </div>)}
            </FieldSet>)}
            {pagination("branches")}
            <CenterHeaderActions><Button variant="primary" onClick={() => requestSaveGrants(member)} busy={busy} busyLabel="جارٍ الحفظ…">حفظ الأدوار</Button><Button onClick={() => setEditing(null)} disabled={busy}>إلغاء</Button></CenterHeaderActions>
          </FieldSet></div> : null}
      />
      {pagination("members")}
    {confirmation ? <ConfirmationDialog title={confirmation.title} description={confirmation.description} confirmLabel={confirmation.confirmLabel}
      onCancel={() => setConfirmation(null)} onConfirm={() => { const action = confirmation.action; setConfirmation(null); action(); }} /> : null}
  </>;
}
