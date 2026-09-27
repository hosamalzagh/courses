import type { StudentCustomField, StudentCustomValues } from "./server-context";
export const customFieldTypeLabels: Record<StudentCustomField["type"], string> =
  {
    text: "نص",
    number: "رقم",
    date: "تاريخ",
    select: "قائمة اختيارات",
    boolean: "نعم / لا",
  };
export function customFieldErrors(
  fields: StudentCustomField[],
  values: StudentCustomValues,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.id];
    const missing = value === undefined || value === null || value === "";
    if (missing) {
      if (field.required)
        errors[`custom_values.${field.id}`] = "هذا الحقل مطلوب.";
      continue;
    }
    const valid =
      field.type === "boolean"
        ? typeof value === "boolean"
        : typeof value === "string" &&
          (field.type === "text"
            ? Array.from(value).length <= 1000
            : field.type === "number"
              ? /^-?\d{1,20}(?:\.\d{1,10})?$/.test(value)
              : field.type === "select"
                ? field.options.includes(value)
                : /^\d{4}-\d{2}-\d{2}$/.test(value));
    if (!valid)
      errors[`custom_values.${field.id}`] =
        "أدخل قيمة صحيحة حسب نوع الحقل وخياراته.";
  }
  return errors;
}
export function customFieldValue(value: string | boolean | null | undefined) {
  return value === true
    ? "نعم"
    : value === false
      ? "لا"
      : value === null || value === undefined || value === ""
        ? "لم تُضف بعد"
        : value;
}
