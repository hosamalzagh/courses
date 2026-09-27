"use client";
import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { PrefetchLink as Link } from "@/components/PrefetchLink";
import { Button } from "@/components/Button";
import { FormField } from "@/components/FormField";
import { ChoiceField } from "@/components/ChoiceField";
import { InlineNotice } from "@/components/InlineNotice";
import { DataTable } from "@/components/DataTable";
import {
  CenterPageActions,
  CenterHeaderActions,
} from "@/components/CenterShell";
import { UnsavedChangesGuard } from "@/components/UnsavedChangesGuard";
import { FieldGroup, FieldLabel, FieldSet } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import {
  centerRequest,
  newSubmissionId,
  responseMessage,
  responseFieldErrors,
} from "@/lib/client-api";
import { customFieldTypeLabels } from "@/lib/student-custom-fields";
import type {
  StudentCustomField,
  StudentCustomFieldContext,
} from "@/lib/server-context";

export function StudentCustomFieldControls({
  context,
}: {
  context: StudentCustomFieldContext;
}) {
  const prefix = useId();
  const router = useRouter();
  const [editor, setEditor] = useState<StudentCustomField | null>(null);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<StudentCustomField["type"]>("text");
  const [position, setPosition] = useState("0");
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const opener = useRef<string | null>(null);
  const dirty = Boolean(
    editor &&
    (label !== editor.label ||
      type !== editor.type ||
      required !== editor.required ||
      position !== String(editor.position) ||
      options !== editor.options.join(" | ")),
  );
  function open(field: StudentCustomField, trigger?: HTMLButtonElement) {
    if (trigger) opener.current = trigger.id;
    setEditor(field);
    setLabel(field.label);
    setType(field.type);
    setPosition(String(field.position));
    setRequired(field.required);
    setOptions(field.options.join(" | "));
    setErrors({});
    setError("");
    setConflict(false);
  }
  function close() {
    setEditor(null);
    setErrors({});
    setError("");
    setConflict(false);
    requestAnimationFrame(() =>
      document.getElementById(opener.current ?? "")?.focus(),
    );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || saving.current || conflict) return;
    const validation: Record<string, string> = {};
    if (!label.trim()) validation.label = "أدخل اسم الحقل.";
    if (!/^\d+$/.test(position) || Number(position) > 1000000)
      validation.position = "أدخل ترتيبًا صحيحًا بين صفر و1000000.";
    const choices =
      type === "select"
        ? options.split("|").map((option) => option.trim())
        : [];
    if (
      type === "select" &&
      (!choices.length ||
        choices.some((choice) => !choice || choice.length > 100) ||
        new Set(choices).size !== choices.length ||
        choices.length > 100)
    )
      validation.options = "أدخل اختيارات غير فارغة ومختلفة، حتى 100 اختيار.";
    if (Object.keys(validation).length) {
      setErrors(validation);
      return;
    }
    saving.current = true;
    setBusy(true);
    setError("");
    setErrors({});
    try {
      const response = await centerRequest(
        `student-custom-fields${editor.revision ? `/${editor.id}` : ""}`,
        editor.revision ? "PATCH" : "POST",
        {
          label: label.trim(),
          position: Number(position),
          required,
          ...(editor.revision
            ? { revision: editor.revision }
            : { id: editor.id, type, options: choices }),
        },
      );
      if (!response.ok) {
        const fields = await responseFieldErrors(response);
        setErrors({
          ...fields,
          ...(Object.keys(fields).some((key) => key.startsWith("options"))
            ? { options: "أدخل اختيارات مختلفة وصحيحة." }
            : {}),
        });
        setError(await responseMessage(response));
        setConflict(response.status === 409);
        return;
      }
      close();
      router.refresh();
    } catch {
      setError("تعذر حفظ الحقل. مدخلاتك محفوظة؛ أعد نفس الطلب.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function reload() {
    if (!editor || saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      const response = await centerRequest(
        `student-custom-fields/${editor.id}`,
        "GET",
      );
      if (!response.ok) {
        setError(await responseMessage(response));
        return;
      }
      open((await response.json()).field);
      requestAnimationFrame(() =>
        document.getElementById(`${prefix}-label`)?.focus(),
      );
    } catch {
      setError("تعذر تحميل تعريف الحقل الحالي.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <CenterPageActions context={context} />
      <UnsavedChangesGuard dirty={dirty} guardHistory />
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      {editor ? (
        <form
          id={`${prefix}-editor`}
          aria-label="تعريف حقل إضافي"
          className="context-card form-stack"
          noValidate
          onSubmit={save}
        >
          <FieldGroup>
            <FieldSet disabled={busy}>
              <FormField
                id={`${prefix}-label`}
                label="اسم الحقل"
                value={label}
                onChange={setLabel}
                error={errors.label}
                required
                focusOnMount
              />
              {editor.revision ? (
                <p>
                  النوع: {customFieldTypeLabels[type]}
                  {type === "select" ? ` — ${options}` : ""}
                </p>
              ) : (
                <>
                  <ChoiceField
                    id={`${prefix}-type`}
                    label="نوع الحقل"
                    value={type}
                    onChange={(value) =>
                      setType(value as StudentCustomField["type"])
                    }
                    disabled={busy}
                    error={errors.type}
                    items={Object.entries(customFieldTypeLabels).map(
                      ([value, label]) => ({ value, label }),
                    )}
                  />
                  {type === "select" ? (
                    <FormField
                      id={`${prefix}-options`}
                      label="اختيارات القائمة"
                      hint="افصل بين كل اختيار وآخر بعلامة |. حتى 100 اختيار."
                      value={options}
                      onChange={setOptions}
                      error={errors.options}
                    />
                  ) : null}
                </>
              )}
              <FormField
                id={`${prefix}-position`}
                label="الترتيب"
                value={position}
                direction="ltr"
                onChange={setPosition}
                error={errors.position}
                hint="الأرقام الأصغر تظهر أولًا."
              />
              <FieldLabel className="flex items-center gap-2">
                <Checkbox
                  checked={required}
                  disabled={busy}
                  onCheckedChange={(checked) => setRequired(Boolean(checked))}
                />
                حقل مطلوب
              </FieldLabel>
              <p className="muted">
                إلزام الحقل يظهر نواقص الملفات القديمة، ويطبق عند حفظ بيانات
                الملف. تبقى المشاركة والإيقاف مستقلين.
              </p>
            </FieldSet>
          </FieldGroup>
        </form>
      ) : null}
      <CenterHeaderActions>
        {editor ? (
          <>
            {conflict ? (
              <Button disabled={busy} onClick={reload}>
                تحميل تعريف الحقل الحالي
              </Button>
            ) : null}
            <Button
              type="submit"
              form={`${prefix}-editor`}
              variant="primary"
              busy={busy}
              disabled={conflict}
            >
              حفظ الحقل
            </Button>
            <Button disabled={busy} onClick={close}>
              إلغاء
            </Button>
          </>
        ) : (
          <Button
            id={`${prefix}-add`}
            variant="primary"
            onClick={(event) =>
              open(
                {
                  id: newSubmissionId(),
                  label: "",
                  type: "text",
                  required: false,
                  position: 0,
                  options: [],
                  revision: 0,
                },
                event.currentTarget,
              )
            }
          >
            إضافة حقل
          </Button>
        )}
      </CenterHeaderActions>
      <DataTable
        id="student-custom-fields"
        title="حقول المركز"
        rows={context.fields}
        rowKey={(field) => field.id}
        searchText={(field) => field.label}
        emptyMessage="لا توجد حقول إضافية. أضف حقلًا من الهيدر."
        description="دفعات محدودة من 50 حقلًا. البحث داخل الدفعة الحالية."
        columns={[
          { key: "label", label: "الحقل", render: (field) => field.label },
          {
            key: "type",
            label: "النوع",
            render: (field) => customFieldTypeLabels[field.type],
          },
          {
            key: "position",
            label: "الترتيب",
            render: (field) => field.position.toLocaleString("ar-EG"),
          },
          {
            key: "required",
            label: "الإلزام",
            render: (field) => (field.required ? "مطلوب" : "اختياري"),
          },
          {
            key: "actions",
            label: "الإجراءات",
            actions: true,
            render: (field) => (
              <Button
                id={`${prefix}-field-${field.id}`}
                disabled={Boolean(editor) || busy}
                onClick={(event) => open(field, event.currentTarget)}
              >
                تعديل
              </Button>
            ),
          },
        ]}
      />
      <nav className="form-actions" aria-label="دفعات الحقول الإضافية">
        {context.pagination.page > 1 ? (
          <Link
            href={`/admin/student-custom-fields?page=${context.pagination.page - 1}`}
          >
            الدفعة السابقة
          </Link>
        ) : null}
        {context.pagination.has_more ? (
          <Link
            href={`/admin/student-custom-fields?page=${context.pagination.page + 1}`}
          >
            الدفعة التالية
          </Link>
        ) : null}
      </nav>
    </>
  );
}
