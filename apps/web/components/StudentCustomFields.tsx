"use client";
import { useRef, useState } from "react";
import { Button } from "./Button";
import { FormField } from "./FormField";
import { ChoiceField } from "./ChoiceField";
import { InlineNotice } from "./InlineNotice";
import { CenterHeaderActions } from "./CenterShell";
import { FieldGroup, FieldLegend, FieldSet } from "./ui/field";
import { centerRequest, responseMessage } from "@/lib/client-api";
import { customFieldValue } from "@/lib/student-custom-fields";
import type {
  StudentCustomFieldList,
  StudentCustomFieldContext,
  StudentCustomValues,
} from "@/lib/server-context";

export function StudentCustomFields({
  prefix,
  list,
  onListChange,
  values,
  onValuesChange,
  studentId,
  errors = {},
  disabled = false,
  onBusyChange,
  onLoadedValues,
  canReadIdentity = true,
  canManageIdentity = true,
}: {
  canReadIdentity?: boolean;
  canManageIdentity?: boolean;
  prefix: string;
  list: StudentCustomFieldList;
  onListChange: (list: StudentCustomFieldList) => void;
  values: StudentCustomValues;
  onValuesChange?: (values: StudentCustomValues) => void;
  studentId?: string;
  errors?: Record<string, string>;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onLoadedValues?: (values: StudentCustomValues) => void;
}) {
  const loading = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [changed, setChanged] = useState(false);
  async function load(page: number) {
    if (loading.current || disabled) return;
    loading.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setFailure("");
    try {
      const params = new URLSearchParams({
        page: String(page),
        ...(studentId ? { student_id: studentId } : {}),
      });
      const response = await centerRequest(
        `student-custom-fields?${params}`,
        "GET",
      );
      if (!response.ok) {
        setFailure(await responseMessage(response));
        return;
      }
      const result = (await response.json()) as StudentCustomFieldContext;
      if (page > 1 && result.revision !== list.revision) {
        setChanged(true);
        setFailure(
          "تغيرت تعريفات الحقول. حمّل التعريفات الحالية؛ مدخلاتك محفوظة.",
        );
        return;
      }
      const fields =
        page === 1
          ? result.fields
          : [
              ...list.fields,
              ...result.fields.filter(
                (field) =>
                  !list.fields.some((existing) => existing.id === field.id),
              ),
            ];
      onListChange({ ...result.pagination, revision: result.revision, fields });
      onLoadedValues?.(result.values);
      setChanged(false);
    } catch {
      setFailure("تعذر تحميل الحقول. مدخلاتك محفوظة؛ أعد المحاولة.");
    } finally {
      loading.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  const edit = Boolean(onValuesChange);
  const visibleFields = list.fields.filter(
    (field) => field.classification !== "identity" || canReadIdentity,
  );
  return (
    <FieldSet aria-label="الحقول الإضافية">
      <FieldLegend>الحقول الإضافية</FieldLegend>
      {failure ? <InlineNotice tone="error">{failure}</InlineNotice> : null}
      {errors.custom_values ? (
        <InlineNotice tone="error">{errors.custom_values}</InlineNotice>
      ) : null}
      {!visibleFields.length ? (
        <p className="muted">لم يعرّف المركز حقولًا إضافية بعد.</p>
      ) : null}
      {edit ? (
        <FieldGroup>
          {visibleFields.map((field) => {
            const value = values[field.id];
            const label = field.label;
            const id = `${prefix}-custom-${field.id}`;
            const error = errors[`custom_values.${field.id}`];
            const update = (value: string | boolean | null) =>
              onValuesChange?.({ ...values, [field.id]: value });
            const readOnlyIdentity =
              field.classification === "identity" && !canManageIdentity;
            if (!field.active || readOnlyIdentity)
              return (
                <div key={field.id}>
                  <p>
                    {label} — {!field.active ? "معطل" : "للقراءة فقط"}
                  </p>
                  <p>
                    <bdi>{customFieldValue(value)}</bdi>
                  </p>
                </div>
              );
            return field.type === "select" || field.type === "boolean" ? (
              <ChoiceField
                key={field.id}
                id={id}
                label={`${label}${field.required ? " (مطلوب)" : ""}`}
                value={
                  value === undefined || value === null ? "" : String(value)
                }
                disabled={disabled || busy}
                error={error}
                onChange={(value) =>
                  update(
                    value === ""
                      ? null
                      : field.type === "boolean"
                        ? value === "true"
                        : value,
                  )
                }
                items={[
                  { value: "", label: "لم يُحدد" },
                  ...(field.type === "boolean"
                    ? [
                        { value: "true", label: "نعم" },
                        { value: "false", label: "لا" },
                      ]
                    : field.options.map((option) => ({
                        value: option,
                        label: field.disabled_options.includes(option)
                          ? `${option} — معطل`
                          : option,
                        disabled: field.disabled_options.includes(option),
                      }))),
                ]}
              />
            ) : (
              <FormField
                key={field.id}
                id={id}
                label={label}
                value={typeof value === "string" ? value : ""}
                onChange={(value) => update(value.trim() === "" ? null : value)}
                error={error}
                required={field.required}
                direction={field.type === "text" ? undefined : "ltr"}
                hint={
                  field.type === "date"
                    ? "تاريخ صحيح بصيغة YYYY-MM-DD."
                    : field.type === "number"
                      ? "رقم موجب أو سالب؛ حتى 20 رقمًا و10 منازل عشرية."
                      : field.required
                        ? "مطلوب عند حفظ بيانات الملف."
                        : "اختياري."
                }
              />
            );
          })}
        </FieldGroup>
      ) : (
        <dl className="student-fields student-data">
          {visibleFields.map((field) => (
            <div key={field.id}>
              <dt>
                {field.label}
                {field.active ? "" : " — معطل"}
                {field.required ? " (مطلوب)" : ""}
              </dt>
              <dd>
                <bdi
                  dir={
                    field.type === "date" || field.type === "number"
                      ? "ltr"
                      : undefined
                  }
                >
                  {customFieldValue(values[field.id])}
                </bdi>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <CenterHeaderActions>
        {edit || changed ? (
          <Button disabled={disabled} busy={busy} onClick={() => load(1)}>
            تحميل تعريفات الحقول الحالية
          </Button>
        ) : null}
        {list.has_more && !changed ? (
          <Button
            disabled={disabled}
            busy={busy}
            onClick={() => load(list.page + 1)}
          >
            تحميل المزيد من الحقول
          </Button>
        ) : null}
      </CenterHeaderActions>
    </FieldSet>
  );
}

export function StudentCustomFieldSummary({
  initial,
  initialValues,
  studentId,
  prefix,
}: {
  initial: StudentCustomFieldList;
  initialValues: StudentCustomValues;
  studentId: string;
  prefix: string;
}) {
  const [list, setList] = useState(initial);
  const [values, setValues] = useState(initialValues);
  // The shared component stays read-only while fetching subsequent values.
  return (
    <StudentCustomFields
      prefix={prefix}
      list={list}
      onListChange={setList}
      values={values}
      studentId={studentId}
      onLoadedValues={(loaded) =>
        setValues((current) => ({ ...current, ...loaded }))
      }
    />
  );
}
