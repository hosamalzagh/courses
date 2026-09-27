"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "./Button";
import { CenterHeaderActions } from "./CenterShell";
import { InlineNotice } from "./InlineNotice";
import { UnsavedChangesGuard } from "./UnsavedChangesGuard";
import { Input } from "./ui/input";
import { Field, FieldLabel, FieldDescription, FieldError } from "./ui/field";
import {
  centerRequest,
  newSubmissionId,
  responseMessage,
} from "@/lib/client-api";
import type { Student, StudentContext } from "@/lib/server-context";

export function StudentPhotoControls({ student }: { student: Student }) {
  const router = useRouter();
  const formId = useId();
  const input = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const [current, setCurrent] = useState(student);
  const [file, setFile] = useState<File | null>(null);
  const [loaded, setLoaded] = useState(student);
  if (loaded !== student) {
    setLoaded(student);
    setCurrent(
      file
        ? { ...current, name: student.name, can_manage: student.can_manage }
        : student,
    );
  }
  const [requestId, setRequestId] = useState(newSubmissionId);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function clear(resetCurrent = true) {
    if (resetCurrent) setCurrent(student);
    setFile(null);
    setError("");
    setNotice("");
    setConflict(false);
    setRequestId(newSubmissionId());
    if (input.current) input.current.value = "";
    input.current?.focus();
  }
  function saved() {
    clear(false);
    setNotice("حُفظت صورة الطالب.");
    router.refresh();
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current || conflict) return;
    setError("");
    setNotice("");
    if (!file) {
      setError("اختر صورة الطالب أولًا.");
      input.current?.focus();
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("اختر صورة لا تتجاوز 10 MB.");
      input.current?.focus();
      return;
    }
    saving.current = true;
    setBusy(true);
    try {
      const body = new FormData();
      body.set("photo", file);
      body.set("request_id", requestId);
      body.set("photo_revision", String(current.photo_revision));
      const response = await centerRequest(
        `students/${current.id}/photo`,
        "POST",
        body,
      );
      if (!response.ok) {
        setConflict(response.status === 409);
        setError(
          response.status === 409
            ? "تغيرت صورة الطالب. حمّل أحدث الصورة ثم راجع اختيارك؛ الملف المختار محفوظ."
            : await responseMessage(response),
        );
        input.current?.focus();
        return;
      }
      const result = await response.json();
      setCurrent({
        ...current,
        photo: result.photo,
        photo_revision: result.photo_revision,
      });
      saved();
    } catch {
      setError(
        "تعذر التأكد من حفظ الصورة. الملف المختار محفوظ؛ أعد المحاولة بنفس الطلب أو حمّل أحدث الصورة.",
      );
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
      const response = await centerRequest(`students/${current.id}`, "GET");
      if (!response.ok) {
        setError(await responseMessage(response));
        return;
      }
      const latest = ((await response.json()) as StudentContext).students[0];
      setCurrent(latest);
      setConflict(false);
      setError("");
      if (latest.photo?.id === requestId) saved();
      else {
        setRequestId(newSubmissionId());
        setNotice("حُمّلت أحدث الصورة. راجع الملف المختار قبل حفظه.");
        router.refresh();
        input.current?.focus();
      }
    } catch {
      setError("تعذر تحميل أحدث الصورة. أعد المحاولة؛ الملف المختار محفوظ.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  if (!current.can_manage) return null;
  return (
    <>
      <UnsavedChangesGuard dirty={Boolean(file)} guardHistory />
      <form
        id={formId}
        aria-label={`صورة الطالب ${current.name}`}
        onSubmit={save}
        noValidate
        className="context-card form-stack"
      >
        <Field data-invalid={Boolean(error)} data-disabled={busy}>
          <FieldLabel htmlFor={`${formId}-file`}>اختيار صورة الطالب</FieldLabel>
          <Input
            ref={input}
            id={`${formId}-file`}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            aria-invalid={Boolean(error)}
            aria-describedby={`${formId}-hint${error ? ` ${formId}-error` : ""}`}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setRequestId(newSubmissionId());
              setError("");
              setNotice("");
            }}
          />
          <FieldDescription id={`${formId}-hint`}>
            صورة شخصية للتعرف على الطالب، بصيغة JPEG أو PNG أو WebP حتى 10 MB.
            وثائق الهوية لها مسار مقيد مستقل. تبقى الصورة الحالية حتى نجاح
            الحفظ.
          </FieldDescription>
          {error ? (
            <FieldError id={`${formId}-error`}>{error}</FieldError>
          ) : null}
        </Field>
        {notice ? <InlineNotice>{notice}</InlineNotice> : null}
      </form>
      <CenterHeaderActions>
        <Button form={formId} type="submit" busy={busy} disabled={conflict}>
          حفظ صورة الطالب
        </Button>
        {file ? (
          <Button disabled={busy} onClick={() => clear()}>
            إلغاء اختيار الصورة
          </Button>
        ) : null}
        {conflict || error ? (
          <Button disabled={busy} onClick={reload}>
            تحميل أحدث صورة الطالب
          </Button>
        ) : null}
      </CenterHeaderActions>
    </>
  );
}
