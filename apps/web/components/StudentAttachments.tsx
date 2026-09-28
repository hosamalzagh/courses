"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./Button";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { CenterHeaderActions } from "./CenterShell";
import { DataTable } from "./DataTable";
import { InlineNotice } from "./InlineNotice";
import { PrefetchLink as Link } from "./PrefetchLink";
import { UnsavedChangesGuard } from "./UnsavedChangesGuard";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { NativeSelect, NativeSelectOption } from "./ui/native-select";
import { buttonVariants } from "./ui/button";
import { centerRequest, newSubmissionId, responseMessage } from "@/lib/client-api";
import type { Student, StudentAttachment, StudentAttachmentPage, StudentAttachmentVersion, StudentContext } from "@/lib/server-context";

type Selection = { file: File; title: string; classification: "general" | "identity" };

export function StudentAttachments({ student, page, canRestore }: { student: Student; page: StudentAttachmentPage; canRestore: boolean }) {
  const router = useRouter();
  const formId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const [selected, setSelected] = useState<Selection[]>([]);
  const [requestId, setRequestId] = useState(newSubmissionId);
  const [revision, setRevision] = useState(student.attachment_revision);
  const [loaded, setLoaded] = useState(student.attachment_revision);
  if (loaded !== student.attachment_revision) {
    setLoaded(student.attachment_revision);
    if (!selected.length) setRevision(student.attachment_revision);
  }
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [invalidIndex, setInvalidIndex] = useState<number | null>(null);
  const [selectedAttachment, setSelectedAttachment] = useState<StudentAttachment | null>(null);
  const [managementDirty, setManagementDirty] = useState(false);
  const selectionTrigger = useRef<HTMLButtonElement | null>(null);

  function reset() {
    setSelected([]);
    setRequestId(newSubmissionId());
    setError("");
    setNotice("");
    setConflict(false);
    setInvalidIndex(null);
    setRevision(student.attachment_revision);
    if (fileInput.current) fileInput.current.value = "";
    fileInput.current?.focus();
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current || conflict) return;
    setError("");
    setNotice("");
    const invalid = selected.findIndex(item => !item.title.trim() || item.file.size > 10 * 1024 * 1024);
    if (!selected.length || invalid !== -1) {
      setInvalidIndex(invalid === -1 ? null : invalid);
      setError(!selected.length ? "اختر مرفقًا واحدًا على الأقل." : "أضف عنوانًا لكل مرفق وتأكد أن حجمه لا يتجاوز 10 MB.");
      if (invalid >= 0 && !selected[invalid].title.trim()) document.getElementById(`${formId}-title-${invalid}`)?.focus();
      else fileInput.current?.focus();
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      const body = new FormData();
      body.set("request_id", requestId);
      body.set("attachment_revision", String(revision));
      selected.forEach((item, index) => {
        body.set(`attachments[${index}][file]`, item.file);
        body.set(`attachments[${index}][title]`, item.title.trim());
        body.set(`attachments[${index}][classification]`, item.classification);
      });
      const response = await centerRequest(`students/${student.id}/attachments`, "POST", body);
      if (!response.ok) {
        setConflict(response.status === 409);
        setError(response.status === 409 ? "تغيرت مرفقات الطالب. حمّل أحدث القائمة ثم راجع الملفات المختارة." : await responseMessage(response));
        fileInput.current?.focus();
        return;
      }
      const result = await response.json();
      setRevision(result.attachment_revision);
      setSelected([]);
      setRequestId(newSubmissionId());
      if (fileInput.current) fileInput.current.value = "";
      setNotice("حُفظت المرفقات.");
      if (page.pagination.page > 1) router.replace(`/admin/students/${student.id}?tab=attachments`);
      else router.refresh();
    } catch {
      setError("تعذر التأكد من الرفع. الملفات المختارة محفوظة؛ أعد المحاولة بنفس الطلب.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  async function reload() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      const response = await centerRequest(`students/${student.id}?tab=attachments`, "GET");
      if (!response.ok) {
        setError(await responseMessage(response));
        return;
      }
      const current = ((await response.json()) as StudentContext).students[0];
      setRevision(current.attachment_revision);
      setRequestId(newSubmissionId());
      setConflict(false);
      setError("");
      setNotice("حُمّلت أحدث المرفقات. راجع الملفات المختارة قبل الرفع.");
      router.refresh();
      fileInput.current?.focus();
    } catch {
      setError("تعذر تحميل أحدث المرفقات. أعد المحاولة.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  const route = (number: number) => `/admin/students/${student.id}?tab=attachments&attachments_status=${page.status}&attachments_page=${number}`;
  return <>
    {!student.can_read_identity ? <InlineNotice>وثائق الهوية لا تظهر أو تُفتح دون صلاحية الهوية في فرع الملف.</InlineNotice> : null}
    <DataTable id="student-attachments" title={page.status === "archived" ? "المرفقات المؤرشفة" : "مرفقات الطالب"} rows={page.entries} rowKey={row => row.id}
      searchText={row => `${row.title} ${row.classification}`} emptyMessage="لا توجد مرفقات متاحة ضمن صلاحياتك."
      description="صور وPDF بصفحات محدودة. البحث داخل الصفحة الحالية؛ يُفحص الوصول من جديد عند كل معاينة أو تنزيل."
      columns={[
        { key: "title", label: "العنوان", render: row => row.title },
        { key: "type", label: "التصنيف", render: row => row.classification === "identity" ? "هوية" : "عام" },
        { key: "size", label: "الحجم", render: row => `${(row.size_bytes / 1024 / 1024).toFixed(2)} MB` },
        { key: "actions", label: "الإجراءات", actions: true, render: row => <span className="flex flex-wrap gap-2">
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href={row.preview_url} target="_blank" rel="noopener noreferrer">معاينة {row.title}</a>
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href={row.download_url}>تنزيل {row.title}</a>
          <Button disabled={Boolean(selectedAttachment)} onClick={event => { selectionTrigger.current = event.currentTarget; setSelectedAttachment(row); }}>نسخ وإجراءات {row.title}</Button>
        </span> },
      ]} />
    {selectedAttachment ? <StudentAttachmentManagement key={selectedAttachment.id} student={student} attachment={selectedAttachment} revision={revision} onRevision={setRevision} onDirtyChange={setManagementDirty} canRestore={canRestore} onClose={(message) => { setManagementDirty(false); setSelectedAttachment(null); if (message) setNotice(message); requestAnimationFrame(() => { if (message) fileInput.current?.focus(); else selectionTrigger.current?.focus(); }); }} /> : null}
    {student.can_manage ? <>
      <UnsavedChangesGuard dirty={selected.length > 0 || managementDirty} guardHistory />
      <form id={formId} aria-label="رفع مرفقات الطالب" onSubmit={save} noValidate className="context-card form-stack">
        <h2>رفع مرفقات جديدة</h2>
        <FieldGroup>
          <Field data-invalid={Boolean(error && !selected.length)} data-disabled={busy}>
            <FieldLabel htmlFor={`${formId}-files`}>اختر صورًا أو PDF</FieldLabel>
            <Input ref={fileInput} id={`${formId}-files`} type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf"
              disabled={busy} aria-invalid={Boolean(error && !selected.length)} onChange={event => {
                const files = Array.from(event.target.files ?? []);
                if (files.length > 5) {
                  setError("اختر حتى 5 ملفات في كل رفع.");
                  event.target.value = "";
                  return;
                }
                setSelected(files.map(file => ({ file, title: file.name.replace(/\.[^.]+$/, "").slice(0, 120), classification: "general" })));
                setRequestId(newSubmissionId());
                setError("");
                setNotice("");
                setInvalidIndex(null);
              }} />
            <FieldDescription>حتى 5 ملفات في الطلب، وكل ملف حتى 10 MB. الصيغ المقبولة JPEG وPNG وWebP وPDF. وثائق الهوية تحتاج منحة الهوية.</FieldDescription>
          </Field>
          {selected.map((item, index) => <FieldGroup key={`${item.file.name}-${index}`}>
            <Field data-invalid={invalidIndex === index && !item.title.trim()} data-disabled={busy}>
              <FieldLabel htmlFor={`${formId}-title-${index}`}>عنوان {item.file.name}</FieldLabel>
              <Input id={`${formId}-title-${index}`} value={item.title} maxLength={120} disabled={busy}
                aria-invalid={invalidIndex === index && !item.title.trim()} onChange={event => {
                  setSelected(current => current.map((entry, position) => position === index ? { ...entry, title: event.target.value } : entry));
                  setRequestId(newSubmissionId());
                  setInvalidIndex(null);
                }} />
            </Field>
            <Field data-disabled={busy}>
              <FieldLabel htmlFor={`${formId}-classification-${index}`}>تصنيف {item.file.name}</FieldLabel>
              <NativeSelect id={`${formId}-classification-${index}`} value={item.classification} disabled={busy}
                onChange={event => {
                  setSelected(current => current.map((entry, position) => position === index ? { ...entry, classification: event.target.value as Selection["classification"] } : entry));
                  setRequestId(newSubmissionId());
                }}>
                <NativeSelectOption value="general">عام</NativeSelectOption>
                {student.can_manage_identity ? <NativeSelectOption value="identity">هوية</NativeSelectOption> : null}
              </NativeSelect>
            </Field>
          </FieldGroup>)}
          {error ? <FieldError role="alert">{error}</FieldError> : null}
          {notice ? <InlineNotice>{notice}</InlineNotice> : null}
        </FieldGroup>
      </form>
    </> : null}
    <CenterHeaderActions>
      {canRestore ? <Link className={buttonVariants({ variant: "outline" })} href={`/admin/students/${student.id}?tab=attachments${page.status === "active" ? "&attachments_status=archived" : ""}`}>{page.status === "active" ? "عرض المؤرشفة" : "عرض الحالية"}</Link> : null}
      {student.can_manage ? <Button form={formId} type="submit" variant="primary" busy={busy} disabled={conflict || !selected.length}>رفع المرفقات</Button> : null}
      {selected.length ? <Button disabled={busy} onClick={reset}>إلغاء اختيار المرفقات</Button> : null}
      {conflict ? <Button disabled={busy} onClick={reload}>تحميل أحدث المرفقات</Button> : null}
      {page.pagination.page > 1 ? <Link className={buttonVariants({ variant: "outline" })} href={route(page.pagination.page - 1)}>المرفقات — الدفعة السابقة</Link> : null}
      {page.pagination.has_more ? <Link className={buttonVariants({ variant: "outline" })} href={route(page.pagination.page + 1)}>المرفقات — الدفعة التالية</Link> : null}
    </CenterHeaderActions>
  </>;
}

function StudentAttachmentManagement({ student, attachment, revision, onRevision, onDirtyChange, canRestore, onClose }: {
  student: Student; attachment: StudentAttachment; revision: number; onRevision: (value: number) => void; onDirtyChange: (value: boolean) => void; canRestore: boolean; onClose: (message?: string) => void;
}) {
  const router = useRouter();
  const formId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const lastKind = useRef<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState(attachment.title);
  const [classification, setClassification] = useState(attachment.classification);
  const [current, setCurrent] = useState(attachment);
  const [requestId, setRequestId] = useState(newSubmissionId);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [versions, setVersions] = useState<StudentAttachmentVersion[]>([]);
  const [versionPage, setVersionPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingVersions, setLoadingVersions] = useState(true);
  const dirty = Boolean(file) || classification !== current.classification || title !== current.title;

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  useEffect(() => {
    let live = true;
    centerRequest(`students/${student.id}/attachments/${attachment.id}/versions?page=${versionPage}`, "GET")
      .then(async response => {
        if (!response.ok) throw new Error(await responseMessage(response));
        const result = await response.json();
        if (live) {
          setVersions(result.versions);
          setHasMore(result.pagination.has_more);
          setError("");
        }
      })
      .catch((failure: Error) => { if (live) setError(failure.message || "تعذر تحميل النسخ."); })
      .finally(() => { if (live) setLoadingVersions(false); });
    return () => { live = false; };
  }, [student.id, attachment.id, versionPage, revision]);

  async function mutate(kind: "replace" | "classification" | "archive" | "restore") {
    if (running.current || conflict) return;
    if (kind === "replace" && (!file || !title.trim() || file.size > 10 * 1024 * 1024)) {
      setError("اختر صورة أو PDF حتى 10 MB وأدخل عنوانًا للنسخة.");
      if (!title.trim()) titleInput.current?.focus();
      else fileInput.current?.focus();
      return;
    }
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const operationId = lastKind.current === kind ? requestId : newSubmissionId();
      lastKind.current = kind;
      setRequestId(operationId);
      const body = kind === "replace" ? new FormData() : { request_id: operationId, attachment_revision: revision, ...kind === "classification" ? { classification } : {} };
      if (body instanceof FormData) {
        body.set("request_id", operationId);
        body.set("attachment_revision", String(revision));
        body.set("title", title.trim());
        body.set("file", file!);
      }
      const response = await centerRequest(`students/${student.id}/attachments/${attachment.id}/${kind}`, kind === "classification" ? "PATCH" : "POST", body);
      if (!response.ok) {
        setConflict(response.status === 409);
        setError(response.status === 409 ? "تغيرت المرفقات. حمّل أحدث القائمة ثم راجع الإجراء." : await responseMessage(response));
        return;
      }
      const result = await response.json();
      onRevision(result.attachment_revision);
      setCurrent(result.attachment);
      setTitle(kind === "classification" ? title : result.attachment.title);
      setClassification(kind === "replace" ? classification : result.attachment.classification);
      if (kind !== "classification") {
        setFile(null);
        if (fileInput.current) fileInput.current.value = "";
      }
      lastKind.current = null;
      setRequestId(newSubmissionId());
      const message = kind === "replace" ? "حُفظت نسخة جديدة وبقيت النسخ السابقة." : kind === "classification" ? "تغير التصنيف؛ ستُفحص صلاحية كل نسخة عند فتحها." : kind === "archive" ? "أُرشف المرفق مع نسخه." : "استُعيد المرفق.";
      setNotice(message);
      router.refresh();
      if (kind === "archive" && !canRestore) { onClose(message); return; }
      setLoadingVersions(true);
    } catch {
      setError("تعذر التأكد من الإجراء. أعد المحاولة بنفس الطلب.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function reload() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const response = await centerRequest(`students/${student.id}/attachments/${attachment.id}/versions`, "GET");
      if (!response.ok) throw new Error(await responseMessage(response));
      const latest = (await response.json()) as { attachment: StudentAttachment; attachment_revision: number; versions: StudentAttachmentVersion[]; pagination: { has_more: boolean } };
      onRevision(latest.attachment_revision);
      setCurrent(latest.attachment);
      setTitle(latest.attachment.title);
      setClassification(latest.attachment.classification);
      setVersions(latest.versions);
      setVersionPage(1);
      setHasMore(latest.pagination.has_more);
      setLoadingVersions(false);
      setRequestId(newSubmissionId());
      lastKind.current = null;
      setConflict(false);
      setError("");
      setNotice("حُمّلت أحدث القائمة. راجع الملف والتصنيف قبل الحفظ.");
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "تعذر تحميل أحدث القائمة.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return <section className="context-card form-stack" aria-label={`نسخ وإجراءات ${current.title}`}>
    <h2>نسخ {current.title}</h2>
    <p>النسخة الحالية رقم {current.current_version.toLocaleString("ar-EG")}{current.archived_at ? " — مؤرشفة" : ""}. يراجع الخادم صلاحية الملف وتصنيف كل نسخة عند كل فتح.</p>
    {loadingVersions ? <p role="status">جارٍ تحميل النسخ…</p> : versions.length ? <ul className="form-stack">
      {versions.map(version => <li key={version.id} className="flex flex-wrap items-center gap-2">
        <span>نسخة {version.version.toLocaleString("ar-EG")} — {version.classification === "identity" ? "هوية" : "عام"} — {version.actor_name ?? `موظف رقم ${version.actor_id.toLocaleString("ar-EG")}`} — {new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(version.created_at.replace(" ", "T") + "Z"))}</span>
        <a className={buttonVariants({ variant: "outline", size: "sm" })} href={version.preview_url} target="_blank" rel="noopener noreferrer">معاينة النسخة {version.version}</a>
        <a className={buttonVariants({ variant: "outline", size: "sm" })} href={version.download_url}>تنزيل النسخة {version.version}</a>
      </li>)}
    </ul> : <p>لا توجد نسخ متاحة.</p>}
    {student.can_manage && !current.archived_at ? <>
      <form id={formId} onSubmit={event => { event.preventDefault(); void mutate("replace"); }} className="form-stack" noValidate aria-label={`استبدال ${current.title}`}>
        <FieldGroup>
          <Field data-disabled={busy}>
            <FieldLabel htmlFor={`${formId}-file`}>ملف النسخة الجديدة</FieldLabel>
            <Input ref={fileInput} id={`${formId}-file`} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setRequestId(newSubmissionId()); }} />
            <FieldDescription>صورة JPEG أو PNG أو WebP أو PDF، حتى 10 MB. تبقى النسخة الحالية حتى نجاح الحفظ.</FieldDescription>
          </Field>
          <Field data-disabled={busy}>
            <FieldLabel htmlFor={`${formId}-title`}>عنوان الوثيقة</FieldLabel>
            <Input ref={titleInput} id={`${formId}-title`} value={title} maxLength={120} disabled={busy} onChange={event => { setTitle(event.target.value); setRequestId(newSubmissionId()); }} />
          </Field>
          <Field data-disabled={busy}>
            <FieldLabel htmlFor={`${formId}-classification`}>تصنيف الوثيقة (يُحفظ بإجراء مستقل)</FieldLabel>
            <NativeSelect id={`${formId}-classification`} value={classification} disabled={busy} onChange={event => { setClassification(event.target.value as StudentAttachment["classification"]); setRequestId(newSubmissionId()); }}>
              <NativeSelectOption value="general">عام</NativeSelectOption>
              {student.can_manage_identity ? <NativeSelectOption value="identity">هوية</NativeSelectOption> : null}
            </NativeSelect>
          </Field>
        </FieldGroup>
      </form>
    </> : null}
    {error ? <FieldError role="alert">{error}</FieldError> : null}
    {notice ? <InlineNotice>{notice}</InlineNotice> : null}
    <CenterHeaderActions>
      {student.can_manage && !current.archived_at ? <Button form={formId} type="submit" variant="primary" busy={busy} disabled={conflict || !file}>حفظ نسخة جديدة</Button> : null}
      {student.can_manage && !current.archived_at && classification !== current.classification ? <Button disabled={busy || conflict} onClick={() => void mutate("classification")}>حفظ التصنيف</Button> : null}
      {student.can_manage && !current.archived_at ? <Button disabled={busy || conflict} onClick={() => setConfirmArchive(true)}>أرشفة الوثيقة</Button> : null}
      {canRestore && current.archived_at ? <Button disabled={busy || conflict} onClick={() => void mutate("restore")}>استعادة الوثيقة</Button> : null}
      {conflict ? <Button disabled={busy} onClick={() => void reload()}>تحميل أحدث المرفقات</Button> : null}
      {versionPage > 1 ? <Button disabled={busy} onClick={() => { setLoadingVersions(true); setVersionPage(page => page - 1); }}>النسخ السابقة</Button> : null}
      {hasMore ? <Button disabled={busy} onClick={() => { setLoadingVersions(true); setVersionPage(page => page + 1); }}>المزيد من النسخ</Button> : null}
      <Button disabled={busy} onClick={() => { if (dirty) setConfirmClose(true); else onClose(); }}>إغلاق النسخ</Button>
    </CenterHeaderActions>
    {confirmArchive ? <ConfirmationDialog title="أرشفة الوثيقة" description={`ستختفي الوثيقة من القائمة الحالية وتبقى نسخها محفوظة. يمكن للمالك أو المسؤول استعادتها.${dirty ? " التعديلات غير المحفوظة ستُترك." : ""}`} confirmLabel="أرشفة الوثيقة" onCancel={() => setConfirmArchive(false)} onConfirm={() => { setConfirmArchive(false); void mutate("archive"); }} /> : null}
    {confirmClose ? <ConfirmationDialog title="إغلاق النسخ دون حفظ" description="هناك ملف أو عنوان أو تصنيف لم يُحفظ. هل تريد إغلاق النسخ وترك التعديلات؟" confirmLabel="إغلاق دون حفظ" onCancel={() => setConfirmClose(false)} onConfirm={() => { setConfirmClose(false); onClose(); }} /> : null}
  </section>;
}
