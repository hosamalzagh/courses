"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, responseMessage } from "@/lib/client-api";
import type { Branch, CenterContext } from "@/lib/server-context";

const roleNames: Record<string, string> = {
  center_owner: "مالك المركز",
  center_admin: "مسؤول المركز",
  branch_manager: "مدير فرع",
  branch_viewer: "قارئ الفرع",
  branch_auditor: "مدقق الفرع",
};

export function BranchWorkspace({ context }: { context: CenterContext }) {
  const router = useRouter();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  function canEdit(branch: Branch) {
    return context.permissions.can_manage_center || (context.permissions.branch_roles[String(branch.id)] ?? []).includes("branch_manager");
  }

  const canAudit = context.permissions.can_manage_center || Object.values(context.permissions.branch_roles)
    .some((roles) => roles.includes("branch_auditor"));

  async function createBranch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const response = await centerRequest("branches", "POST", { name: newName, slug: newSlug, address: newAddress || null });
      if (!response.ok) {
        setError(await responseMessage(response));
        return;
      }
      setShowCreate(false);
      setNewName("");
      setNewSlug("");
      setNewAddress("");
      setNotice("أُنشئ الفرع.");
      router.refresh();
    } catch {
      setError("تعذر حفظ الفرع. تحقق من الاتصال وحاول مرة أخرى.");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(branch: Branch) {
    setEditing(branch.id);
    setEditName(branch.name);
    setEditAddress(branch.address ?? "");
    setError("");
    setNotice("");
  }

  async function saveBranch(event: FormEvent<HTMLFormElement>, branchId: number) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const response = await centerRequest(`branches/${branchId}`, "PATCH", { name: editName, address: editAddress || null });
      if (!response.ok) {
        setError(await responseMessage(response));
        return;
      }
      setEditing(null);
      setNotice("حُفظت بيانات الفرع.");
      router.refresh();
    } catch {
      setError("تعذر حفظ التعديل. حاول مرة أخرى.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      const response = await centerRequest("auth/logout", "POST");
      if (!response.ok) {
        setError(await responseMessage(response));
        return;
      }
      router.replace("/login");
      router.refresh();
    } catch {
      setError("تعذر تسجيل الخروج. حاول مرة أخرى.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace">
      <header className="workspace-header"><div className="workspace-header-inner">
        <div className="brand"><span className="brand-mark" aria-hidden="true">C</span><span>Courses</span></div>
        <div className="workspace-header-actions"><span className="muted">{context.user.name}</span><button className="button button-secondary" type="button" onClick={signOut} disabled={busy}>تسجيل الخروج</button></div>
      </div></header>
      <main className="workspace-main">
        <section>
          <div className="page-heading"><div><span className="eyebrow">لوحة المركز</span><h1>{context.center.name}</h1><p className="muted">فروع المركز التي يمكنك الوصول إليها الآن.</p></div></div>
          {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
          {notice ? <InlineNotice>{notice}</InlineNotice> : null}
          <div className="page-heading"><h2 className="section-heading">الفروع</h2>{context.permissions.can_manage_center ? <button className="button button-primary" type="button" onClick={() => { setShowCreate(!showCreate); setError(""); }}> {showCreate ? "إلغاء" : "إنشاء فرع"}</button> : null}</div>
          {context.permissions.can_manage_center || canAudit ? <nav className="workspace-links" aria-label="إدارة المركز">
            {context.permissions.can_manage_center ? <><a className="text-link" href="/admin/members">إدارة الموظفين والدعوات</a><a className="text-link" href="/admin/settings">إعدادات المركز</a></> : null}
            {canAudit ? <a className="text-link" href="/admin/audit">سجل التدقيق</a> : null}
          </nav> : null}

          {showCreate ? <form className="context-card form-stack" noValidate onSubmit={createBranch}>
            <h3>فرع جديد</h3>
            <FormField id="branch-name" label="اسم الفرع" value={newName} onChange={setNewName} required />
            <FormField id="branch-slug" label="رمز الفرع" value={newSlug} onChange={setNewSlug} direction="ltr" hint="حروف إنجليزية صغيرة وأرقام وشرطة فقط" required />
            <FormField id="branch-address" label="العنوان" value={newAddress} onChange={setNewAddress} />
            <button className="button button-primary" type="submit" disabled={busy || !newName || !newSlug}>{busy ? "جارٍ الحفظ…" : "حفظ الفرع"}</button>
          </form> : null}

          {context.branches.length === 0 ? <div className="empty-state"><h3>لا توجد فروع متاحة لك</h3><p className="muted">{context.permissions.can_manage_center ? "أنشئ الفرع الأول ليظهر هنا." : "اطلب من مسؤول المركز إسنادك إلى فرع."}</p></div> :
            <div className="branch-list">{context.branches.map((branch) => <article className="branch-card" key={branch.id}>
              <h3>{branch.name}</h3><p>{branch.address || "لم يُضف عنوان بعد"}</p>
              <div className="branch-card-actions">{canEdit(branch) ? <button className="button button-secondary" type="button" onClick={() => startEdit(branch)}>تعديل بيانات الفرع</button> : <span className="muted">صلاحية عرض فقط</span>}</div>
              {editing === branch.id ? <form className="edit-panel form-stack" noValidate onSubmit={(event) => saveBranch(event, branch.id)}>
                <FormField id={`name-${branch.id}`} label="اسم الفرع" value={editName} onChange={setEditName} required />
                <FormField id={`address-${branch.id}`} label="العنوان" value={editAddress} onChange={setEditAddress} />
                <div className="branch-card-actions"><button className="button button-primary" type="submit" disabled={busy || !editName}>{busy ? "جارٍ الحفظ…" : "حفظ التعديل"}</button><button className="button button-secondary" type="button" onClick={() => setEditing(null)} disabled={busy}>إلغاء</button></div>
              </form> : null}
            </article>)}</div>}
        </section>
        <aside className="context-card"><span className="eyebrow">عضويتك الحالية</span><h2>{context.user.name}</h2><p><bdi dir="ltr">{context.user.email}</bdi></p><p className="muted">الحالة: {context.membership.status === "active" ? "نشطة" : "غير نشطة"}</p><div className="role-list">{context.permissions.center_roles.map((role) => <span className="role-pill" key={role}>{roleNames[role] || role}</span>)}</div><p className="muted">تُراجع صلاحياتك مع كل طلب محمي، لذلك يسري أي تغيير في دورك من الطلب التالي.</p></aside>
      </main>
    </div>
  );
}
