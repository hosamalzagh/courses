"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./Button";
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
import type { Student, StudentAttachmentPage, StudentContext } from "@/lib/server-context";

type Selection = { file: File; title: string; classification: "general" | "identity" };

export function StudentAttachments({ student, page }: { student: Student; page: StudentAttachmentPage }) {
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

  const route = (number: number) => `/admin/students/${student.id}?tab=attachments&attachments_page=${number}`;
  return <>
    {!student.can_read_identity ? <InlineNotice>وثائق الهوية لا تظهر أو تُفتح دون صلاحية الهوية في فرع الملف.</InlineNotice> : null}
    <DataTable id="student-attachments" title="مرفقات الطالب" rows={page.entries} rowKey={row => row.id}
      searchText={row => `${row.title} ${row.classification}`} emptyMessage="لا توجد مرفقات متاحة ضمن صلاحياتك."
      description="صور وPDF بصفحات محدودة. البحث داخل الصفحة الحالية؛ يُفحص الوصول من جديد عند كل معاينة أو تنزيل."
      columns={[
        { key: "title", label: "العنوان", render: row => row.title },
        { key: "type", label: "التصنيف", render: row => row.classification === "identity" ? "هوية" : "عام" },
        { key: "size", label: "الحجم", render: row => `${(row.size_bytes / 1024 / 1024).toFixed(2)} MB` },
        { key: "actions", label: "الإجراءات", actions: true, render: row => <span className="flex flex-wrap gap-2">
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href={row.preview_url} target="_blank" rel="noopener noreferrer">معاينة {row.title}</a>
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href={row.download_url}>تنزيل {row.title}</a>
        </span> },
      ]} />
    {student.can_manage ? <>
      <UnsavedChangesGuard dirty={selected.length > 0} guardHistory />
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
      {student.can_manage ? <Button form={formId} type="submit" variant="primary" busy={busy} disabled={conflict || !selected.length}>رفع المرفقات</Button> : null}
      {selected.length ? <Button disabled={busy} onClick={reset}>إلغاء اختيار المرفقات</Button> : null}
      {conflict ? <Button disabled={busy} onClick={reload}>تحميل أحدث المرفقات</Button> : null}
      {page.pagination.page > 1 ? <Link className={buttonVariants({ variant: "outline" })} href={route(page.pagination.page - 1)}>المرفقات — الدفعة السابقة</Link> : null}
      {page.pagination.has_more ? <Link className={buttonVariants({ variant: "outline" })} href={route(page.pagination.page + 1)}>المرفقات — الدفعة التالية</Link> : null}
    </CenterHeaderActions>
  </>;
}
