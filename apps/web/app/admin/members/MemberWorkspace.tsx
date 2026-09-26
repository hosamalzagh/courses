"use client";

import styles from "./MemberWorkspace.module.css";
import { useState, useEffect, useRef, type FormEvent } from "react";
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

export function MemberWorkspace({ context }: { context: MemberContext }) {
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
    return <div className="form-actions" aria-label={`صفحات ${section === "members" ? "الموظفين" : section === "invitations" ? "الدعوات" : "الفروع"}`}>
      <button type="button" className="button button-secondary" disabled={busy || state.page === 1} onClick={() => requestPageChange(section, state.page - 1)}>الدفعة السابقة</button>
      <span>دفعة {state.page} · حتى ٥٠ سجلًا؛ البحث داخل الدفعة المعروضة</span>
      <button type="button" className="button button-secondary" disabled={busy || !state.has_more} onClick={() => requestPageChange(section, state.page + 1)}>الدفعة التالية</button>
    </div>;
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

  return <div className="workspace">
    <header className="workspace-header"><div className="workspace-header-inner"><a className="brand" href="/admin"><span className="brand-mark">C</span>Courses</a><span className="muted">{context.center.name} · عضويتك نشطة</span><a className="text-link" href="/admin">العودة إلى الفروع</a></div></header>
    <main className={`members-main ${styles.workspace}`}>
      <div><span className="eyebrow">{context.center.name}</span><h1>موظفو المركز</h1><p className="muted">الدعوات والعضويات وأدوار كل فرع.</p></div>
      <details className="context-card"><summary>مصفوفة الأدوار والإجراءات</summary>
        <p>مالك المركز ومسؤوله يحتفظان بصلاحياتهما على جميع الفروع. الأدوار التالية تُجمع لكل فرع، ومنح الاعتماد المالي للمالك فقط.</p>
        <dl>{Object.entries(workspace.grant_options).map(([role, option]) => <div key={role}><dt><strong>{option.label}</strong></dt><dd>{option.description}</dd></div>)}</dl>
      </details>

      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      <section className="context-card"><h2>دعوة موظف</h2><form className="member-invite-form" noValidate onSubmit={invite}>
        <FormField id="invite-email" label="البريد الإلكتروني" type="email" value={email} onChange={(value) => { setEmail(value); setFieldErrors({}); }} error={fieldErrors.email} direction="ltr" required />
        {isOwner ? <label className="check-row"><input type="checkbox" checked={inviteAsAdmin} onChange={(event) => setInviteAsAdmin(event.target.checked)} />دعوة بصفة مسؤول مركز</label> : null}
        <button className="button button-primary" disabled={busy || !email}>{busy ? "جارٍ إرسال الدعوة…" : "إرسال الدعوة"}</button>
      </form></section>
      {invitations.length > 0 ? <section><h2 className="section-heading">الدعوات</h2><div className="member-list">{invitations.map((invitation) => <div className="member-card" key={invitation.id}><bdi dir="ltr">{invitation.email}</bdi><span className="role-pill">{invitationLabels[invitation.status]}</span><span className="muted">{invitation.status === "expired" ? "انتهت" : "تنتهي"} {new Date(invitation.expires_at).toLocaleDateString("ar-EG")}</span>{invitation.status === "uncertain" ? <span className="muted">تحقق من تسليم البريد مع دعم المنصة قبل إعادة الدعوة.</span> : null}{invitation.status === "not_sent" ? <span className="muted">يمكنك إعادة إرسال الدعوة من النموذج أعلاه.</span> : null}</div>)}</div></section> : null}
      {pagination("invitations")}
      <section><h2 className="section-heading">العضويات</h2>
        <div className="member-list">{members.map((member) => <article className="member-card" key={member.id}>
          <div className="member-card-head"><div><h3>{member.user.name}</h3><p className="muted"><bdi dir="ltr">{member.user.email}</bdi></p></div><span className="role-pill">{member.status === "active" ? "نشط" : "موقوف"}</span></div>
          <p className="muted">{member.center_roles.includes("center_owner") ? "مالك المركز" : member.center_roles.includes("center_admin") ? "مسؤول المركز" : "موظف المركز"}</p>
          <div className="member-actions">{isOwner || !member.center_roles.includes("center_owner") ? <button className="button button-secondary" type="button" onClick={(event) => edit(member, event.currentTarget)} disabled={busy}>تعديل الأدوار</button> : null}<button className="button button-secondary" type="button" onClick={() => requestStatusChange(member)} disabled={busy || (member.user.id === context.user.id && member.center_roles.includes("center_owner"))}>{busy ? "جارٍ التحديث…" : member.status === "active" ? "إيقاف العضوية" : "تنشيط العضوية"}</button></div>
          { editing === member.id ? <div ref={editor} className="grant-editor" role="region" aria-label={`أدوار ${member.user.name}`}><fieldset disabled={busy}><legend>أدوار المركز</legend>
            {isOwner ? <label className="check-row"><input type="checkbox" checked={centerRoles.includes("center_owner")} onChange={() => toggleCenter("center_owner")} />مالك المركز</label> : null}
            {isOwner ? <label className="check-row"><input type="checkbox" checked={centerRoles.includes("center_admin")} onChange={() => toggleCenter("center_admin")} />مسؤول المركز</label> : null}
            <h4>إسنادات الفروع</h4>{workspace.branches.map((branch) => <fieldset key={branch.id} className="branch-grant"><legend>{branch.name}</legend>
              {[false, true].map((additional) => <div key={String(additional)}><h5>{additional ? "صلاحيات إضافية مستقلة" : "أدوار التشغيل"}</h5>
                {Object.entries(workspace.grant_options).filter(([, option]) => Boolean(option.additional) === additional).map(([role, option]) => <label className="check-row" key={role}>
                  <input type="checkbox" disabled={Boolean(option.owner_only && !isOwner)} checked={(branchRoles[String(branch.id)] ?? []).includes(role)} onChange={() => toggleBranch(branch.id, role)} />{option.label}
                </label>)}
              </div>)}
            </fieldset>)}
            {pagination("branches")}
            <div className="form-actions"><button className="button button-primary" type="button" onClick={() => requestSaveGrants(member)} disabled={busy}>{busy ? "جارٍ حفظ الأدوار…" : "حفظ الأدوار"}</button><button className="button button-secondary" type="button" onClick={() => setEditing(null)} disabled={busy}>إلغاء</button></div>
          </fieldset></div> : null}
        </article>)}</div>
      </section>
      {pagination("members")}
    </main>
    {confirmation ? <ConfirmationDialog title={confirmation.title} description={confirmation.description} confirmLabel={confirmation.confirmLabel}
      onCancel={() => setConfirmation(null)} onConfirm={() => { const action = confirmation.action; setConfirmation(null); action(); }} /> : null}
  </div>;
}
