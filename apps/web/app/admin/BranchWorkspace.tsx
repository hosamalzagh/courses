"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CenterShell } from "@/components/CenterShell";
import { DataTable } from "@/components/DataTable";
import { Button } from "@/components/Button";
import { FormField } from "@/components/FormField";
import { InlineNotice } from "@/components/InlineNotice";
import { centerRequest, responseFieldErrors, responseMessage } from "@/lib/client-api";
import type { Branch, CenterContext } from "@/lib/server-context";

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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function canEdit(branch: Branch) {
    return context.permissions.can_manage_center || (context.permissions.branch_roles[String(branch.id)] ?? []).includes("branch_manager");
  }

  async function createBranch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setFieldErrors({});
    setNotice("");
    setBusy(true);
    try {
      const response = await centerRequest("branches", "POST", { name: newName, slug: newSlug, address: newAddress || null });
      if (!response.ok) {
        setFieldErrors(await responseFieldErrors(response));
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
    setError(""); setFieldErrors({});
    setNotice("");
  }

  async function saveBranch(event: FormEvent<HTMLFormElement>, branchId: number) {
    event.preventDefault();
    setError(""); setFieldErrors({});
    setNotice("");
    setBusy(true);
    try {
      const response = await centerRequest(`branches/${branchId}`, "PATCH", { name: editName, address: editAddress || null });
      if (!response.ok) {
        setFieldErrors(await responseFieldErrors(response));
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

  return <CenterShell context={context} title="الفروع" description="فروع المركز التي يمكنك الوصول إليها." actions={context.permissions.can_manage_center ? <Button variant="primary" disabled={busy} onClick={() => { setShowCreate(true); setEditing(null); setError(""); setFieldErrors({}); }}>إنشاء فرع</Button> : null}>
    <main className="members-main">
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      {showCreate ? <form className="context-card form-stack" noValidate onSubmit={createBranch} aria-label="فرع جديد">
        <h2>فرع جديد</h2>
        <FormField id="branch-name" focusOnMount label="اسم الفرع" value={newName} onChange={(value) => { setNewName(value); setFieldErrors({}); }} error={fieldErrors.name} required />
        <FormField id="branch-slug" label="رمز الفرع" value={newSlug} onChange={(value) => { setNewSlug(value); setFieldErrors({}); }} direction="ltr" hint="حروف إنجليزية صغيرة وأرقام وشرطة فقط" error={fieldErrors.slug} required />
        <FormField id="branch-address" label="العنوان" value={newAddress} onChange={(value) => { setNewAddress(value); setFieldErrors({}); }} error={fieldErrors.address} />
        <div className="form-actions"><Button variant="primary" type="submit" busy={busy} disabled={!newName || !newSlug}>حفظ الفرع</Button><Button disabled={busy} onClick={() => setShowCreate(false)}>إلغاء</Button></div>
      </form> : null}
      <DataTable id="branches" title="الفروع" rows={context.branches} rowKey={(branch) => branch.id} searchText={(branch) => `${branch.name} ${branch.slug} ${branch.address ?? ""}`} rowClassName="branch-row"
        emptyMessage={context.permissions.can_manage_center ? "أنشئ الفرع الأول ليظهر هنا." : "لا توجد فروع متاحة لك. اطلب من مسؤول المركز إسنادك إلى فرع."}
        columns={[
          { key: "name", label: "الفرع", filterText: (branch) => branch.name, render: (branch) => <h3>{branch.name}</h3> },
          { key: "slug", label: "رمز الفرع", filterText: (branch) => branch.slug, render: (branch) => <bdi dir="ltr" className="table-code">{branch.slug}</bdi> },
          { key: "address", label: "العنوان", filterText: (branch) => branch.address ?? "", render: (branch) => <span className="muted">{branch.address || "لم يُضف عنوان بعد"}</span> },
          { key: "actions", label: "الإجراءات", actions: true, render: (branch) => canEdit(branch) ? <Button disabled={busy} onClick={() => { startEdit(branch); setShowCreate(false); }}>تعديل بيانات الفرع</Button> : <span className="muted">صلاحية عرض فقط</span> },
        ]}
        expanded={(branch) => editing === branch.id ? <form className="edit-panel form-stack" noValidate aria-label={`تعديل ${branch.name}`} onSubmit={(event) => saveBranch(event, branch.id)}>
          <h3>تعديل {branch.name}</h3>
          <FormField id={`name-${branch.id}`} focusOnMount label="اسم الفرع" value={editName} onChange={(value) => { setEditName(value); setFieldErrors({}); }} error={fieldErrors.name} required />
          <FormField id={`address-${branch.id}`} label="العنوان" value={editAddress} onChange={(value) => { setEditAddress(value); setFieldErrors({}); }} error={fieldErrors.address} />
          <div className="form-actions"><Button variant="primary" type="submit" busy={busy} disabled={!editName}>حفظ التعديل</Button><Button onClick={() => setEditing(null)} disabled={busy}>إلغاء</Button></div>
        </form> : null}
      />
    </main>
  </CenterShell>;
}
